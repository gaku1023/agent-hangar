import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { IntentRoot } from '../intent/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import type { ProjectCardProps } from '../presenters/projects.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { Header } from './Header.tsx';
import { MemoEditor } from './MemoEditor.tsx';
import { ProjectCard } from './ProjectCard.tsx';
import { ProjectScreen } from './ProjectScreen.tsx';
import { TodoList } from './TodoList.tsx';
import { RollingNumber } from './primitives/RollingNumber.tsx';
import { UsageGauge } from './primitives/UsageGauge.tsx';

const art = (id: string, over: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: '題名 ' + id, description: '説明', favicon: '📊', url: 'https://claude.ai/code/artifact/' + id, lastPublished: '1 分前', versionCount: 2, canOpenEditor: false, ...over });
const card = (over: Partial<ProjectCardProps> = {}): ProjectCardProps => ({ id: 'p1', name: 'alpha', path: '/w/alpha', resolved: true, status: 'active', lastActivity: '1 時間前', runningCount: 0, waitingCount: 0, openTodoCount: 0, memoHead: null, excerpt: 'セッションはまだありません', excerptFromPrompt: false, ...over });
const wrap = (node: ReactNode, onIntent = vi.fn()) => { render(<IntentRoot onIntent={onIntent}>{node}</IntentRoot>); return onIntent; };

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
  it('値が変わると古い値を添えて回し、150 ミリ秒で片付ける', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<RollingNumber value={10} suffix="%" />);
      expect(container.querySelector('.roll-old')).toBeNull();
      rerender(<RollingNumber value={20} suffix="%" />);
      expect(container.querySelector('.roll')?.getAttribute('data-rolling')).toBe('true');
      expect(container.querySelector('.roll-old')?.textContent).toBe('10%');
      expect(container.querySelector('.roll-new')?.textContent).toBe('20%');
      act(() => { vi.advanceTimersByTime(150); });
      expect(container.querySelector('.roll-old')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// 同期を設定していない端末のヘッダー。フェーズ 3 のゲージの検査はこの形のままである。
const noSync = { visible: false, state: 'off' as const, label: '', pending: 0, sweepPending: 0, skipped: 0, paused: false };

describe('Header', () => {
  it('2 つのゲージと最終更新を出す', () => {
    render(<IntentRoot onIntent={() => {}}><Header newSession={{}} indexLabel={null} usage={{ fiveHour: 47, sevenDay: 7, fiveHourResets: '18:00', sevenDayResets: '10/4 09:00', updatedLabel: '10 分前' }} sync={noSync} /></IntentRoot>);
    expect(screen.getByRole('meter', { name: '5 時間枠の使用率' })).toBeTruthy();
    expect(screen.getByRole('meter', { name: '週の枠の使用率' })).toBeTruthy();
    // 何の割合かが画面から読めるよう、見出しを常に出す。
    expect(screen.getByText('5 時間')).toBeTruthy();
    expect(screen.getByText('週')).toBeTruthy();
    // ホバーで、枠が戻る時刻と最終更新を読める。最終更新は狭いヘッダで畳むので、title にも添える。
    expect(screen.getByText('5 時間').closest('.gauge')).toHaveAttribute('title', '5 時間枠の使用率 47%、18:00 に戻ります、最終更新 10 分前');
    expect(screen.getByText('週').closest('.gauge')).toHaveAttribute('title', '週の枠の使用率 7%、10/4 09:00 に戻ります、最終更新 10 分前');
    expect(screen.getByText('最終更新 10 分前')).toBeTruthy();
  });
  // 幅が狭いと、同期のボタンと錠剤の文字と新規セッションの文字を畳む（headerFold.ts が測って畳む）。畳んでも同じ操作ができる。
  it('畳んだときの逃げ道。同期の文は設定へ、虫眼鏡はパレットへ、新規セッションは名前を残す', () => {
    const onIntent = vi.fn();
    const sync = { visible: true, state: 'idle' as const, label: '同期済み · 3 分前', pending: 2, sweepPending: 0, skipped: 0, paused: false };
    render(<IntentRoot onIntent={onIntent}><Header newSession={{}} indexLabel={null} usage={{ fiveHour: 42, sevenDay: 18, fiveHourResets: null, sevenDayResets: null, updatedLabel: '3 分前' }} sync={sync} /></IntentRoot>);
    fireEvent.click(screen.getByRole('link', { name: '同期済み · 3 分前' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
    fireEvent.click(screen.getByRole('button', { name: '探す・移動' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.open' });
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open' });
  });
  it('最終更新が無ければ添えない', () => {
    render(<IntentRoot onIntent={() => {}}><Header newSession={{}} indexLabel={null} usage={{ fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }} sync={noSync} /></IntentRoot>);
    expect(screen.queryByText(/最終更新/)).toBeNull();
    expect(screen.getAllByText('未取得')).toHaveLength(2);
    // 戻る時刻が届いていなければ、title に時刻を添えない。
    expect(screen.getByText('5 時間').closest('.gauge')).toHaveAttribute('title', '5 時間枠の使用率 未取得');
  });
});

describe('TodoList', () => {
  it('追加、反転、削除の Intent を出す', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false, candidate: null }, { id: 't2', text: '済んだ', done: true, candidate: null }]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: '書く' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.add', projectId: 'p1', text: '書く' });
    fireEvent.click(screen.getByLabelText('買う（1 件目）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByLabelText('済んだ（2 件目）を削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.remove', id: 't2' });
    expect(input.getAttribute('id')).toBe('todo-input');
  });
  it('候補の行は根拠とセッションと確定と却下を出し、欄を押すと反転の Intent を出す', () => {
    const cand = { note: '直して確かめた', sessionId: 's1', sessionName: '起動画面の作り直し', ago: '12 分前' };
    const onIntent = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '窓を掴める', done: false, candidate: cand }, { id: 't2', text: '影の値', done: false, candidate: { ...cand, sessionId: null, sessionName: '不明なセッション' } }]} />);
    expect(screen.getByText('直して確かめた', { selector: '#todo-why-t1' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目、完了の候補）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't1' });
    fireEvent.click(screen.getByRole('button', { name: '起動画面の作り直し' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.open', id: 's1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目）を確定'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.confirm', id: 't1' });
    fireEvent.click(screen.getByLabelText('窓を掴める（1 件目）を却下'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.reject', id: 't1' });
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
    const onIntent = wrap(<TodoList projectId="p1" todos={[]} />);
    fireEvent.keyDown(screen.getByLabelText('TODO を追加'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByText('TODO はまだありません')).toBeTruthy();
  });
  it('同じ文言の TODO が並んでもラベルが重ならない', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[{ id: 't1', text: '買う', done: false, candidate: null }, { id: 't2', text: '買う', done: true, candidate: null }]} />);
    fireEvent.click(screen.getByLabelText('買う（2 件目）'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.toggle', id: 't2' });
    fireEvent.click(screen.getByLabelText('買う（1 件目）を削除'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'todo.remove', id: 't1' });
  });
  it('日本語の変換中の Enter では追加しない', () => {
    const onIntent = wrap(<TodoList projectId="p1" todos={[]} />);
    const input = screen.getByLabelText('TODO を追加');
    fireEvent.change(input, { target: { value: 'かう' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
  });
});

describe('MemoEditor', () => {
  it('保存すると memo.save を出す', () => {
    const onIntent = wrap(<MemoEditor projectId="p1" markdown="# a" updatedAt={1} />);
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: '# b' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'memo.save', projectId: 'p1', markdown: '# b' });
  });
  it('下書きが無ければ外部の更新をそのまま取り込む', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={2} /></IntentRoot>);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 外');
    expect(screen.queryByText('外部で更新されました')).toBeNull();
  });
  it('下書きがあれば捨てずに知らせ、読み込むで差し替える', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('メモ'), { target: { value: '# 書きかけ' } });
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={2} /></IntentRoot>);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 書きかけ');
    expect(screen.getByText('外部で更新されました')).toBeTruthy();
    fireEvent.click(screen.getByText('読み込む'));
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('# 外');
  });
  it('自分の保存が戻ってきただけなら外部の更新と言わない', () => {
    const { rerender } = render(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# a" updatedAt={1} /></IntentRoot>);
    const area = screen.getByLabelText('メモ') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: '# b' } });
    fireEvent.click(screen.getByText('保存'));
    // 保存の直後に書き足す。ここで自分の保存がサーバから戻ってくる。
    fireEvent.change(area, { target: { value: '# b の続き' } });
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# b" updatedAt={2} /></IntentRoot>);
    expect(screen.queryByText('外部で更新されました')).toBeNull();
    expect(area.value).toBe('# b の続き');
    // 本当に外から書き換わったときだけ知らせる。
    rerender(<IntentRoot onIntent={() => {}}><MemoEditor projectId="p1" markdown="# 外" updatedAt={3} /></IntentRoot>);
    expect(screen.getByText('外部で更新されました')).toBeTruthy();
  });
  it('書き換えていなければ保存できない', () => {
    wrap(<MemoEditor projectId="p1" markdown="# a" updatedAt={1} />);
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ArtifactCards', () => {
  it('クリックで開き、編集ボタンは元ファイルがあるときだけ出す', () => {
    const onIntent = wrap(<ArtifactCards projectId="p1" artifacts={[art('a1'), art('a2', { canOpenEditor: true })]} canAdd />);
    fireEvent.click(screen.getByText('題名 a1'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.open', id: 'a1' });
    expect(screen.getAllByText('VS Code で開く')).toHaveLength(1);
    fireEvent.click(screen.getByText('VS Code で開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.openEditor', id: 'a2' });
    const url = screen.getByLabelText('アーティファクトの URL');
    fireEvent.change(url, { target: { value: 'https://claude.ai/code/artifact/x' } });
    fireEvent.click(screen.getByText('追加'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'artifact.add', projectId: 'p1', url: 'https://claude.ai/code/artifact/x' });
  });
  it('canAdd が偽なら追加欄を出さない', () => {
    wrap(<ArtifactCards projectId={null} artifacts={[]} canAdd={false} />);
    expect(screen.queryByLabelText('アーティファクトの URL')).toBeNull();
    expect(screen.getByText('アーティファクトはまだありません')).toBeTruthy();
  });
});

describe('ProjectScreen の右レール', () => {
  const props = { id: 'p1', name: 'alpha', parent: { label: 'プロジェクト', route: { name: 'projects' as const } }, path: '/w/alpha', resolved: true, status: 'active' as const, sessions: [], notFound: false, isScratch: false, todos: [{ id: 't1', text: '買う', done: false, candidate: null }], memo: { markdown: '# a', updatedAt: 1 }, artifacts: [art('a1')] };
  it('TODO とメモとアーティファクトを並べ、折りたためる', () => {
    wrap(<ProjectScreen {...props} />);
    expect(screen.getByLabelText('TODO を追加')).toBeTruthy();
    expect(screen.getByLabelText('メモ')).toBeTruthy();
    expect(screen.getByText('題名 a1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('右の欄を閉じる'));
    expect(screen.queryByLabelText('TODO を追加')).toBeNull();
  });
  it('スクラッチのプロジェクトは操作を絞る', () => {
    wrap(<ProjectScreen {...props} isScratch />);
    expect(screen.getByText('スクラッチで始める')).toBeTruthy();
    expect(screen.queryByText('新しいセッション')).toBeNull();
  });
});

describe('ProjectCard の追加分', () => {
  it('メモの 1 行目を出し、ここで始めるは親のクリックを巻き込まない', () => {
    const onIntent = wrap(<ProjectCard {...card({ memoHead: '買い物の段取り' })} />);
    expect(screen.getByText('買い物の段取り')).toBeTruthy();
    fireEvent.click(screen.getByText('ここで始める'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p1' });
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'project.open', id: 'p1' });
  });
  it('メモが無ければその行を出さない', () => {
    const { container } = render(<IntentRoot onIntent={vi.fn()}><ProjectCard {...card()} /></IntentRoot>);
    expect(container.querySelector('.card-memo')).toBeNull();
    expect(screen.getByText('ここで始める')).toBeTruthy();
  });
});
