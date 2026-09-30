import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadinessDto } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { presentOnboarding } from '../presenters/onboarding.ts';
import { initialStore } from '../store/store.ts';
import { HomeScreen } from './HomeScreen.tsx';

const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash x', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
};
const emptyHome = { attention: [], confirm: [], running: [], recent: [], projects: [] };

describe('presentOnboarding', () => {
  it('セッションもプロジェクトも無いときだけ出す。スクラッチのプロジェクトは数えない', () => {
    const store = { ...initialStore(), bootstrapped: true, readiness: READY };
    expect(presentOnboarding(store)).toMatchObject({ checks: { progress: '5 つ中 2 つ' } });
    expect(presentOnboarding({ ...store, bootstrapped: false })).toBeNull();
    const s = { id: 's1' } as never;
    expect(presentOnboarding({ ...store, sessions: { s1: s } })).toBeNull();
    const p = (isScratch: boolean) => ({ id: 'p1', name: 'alpha', isScratch }) as never;
    expect(presentOnboarding({ ...store, projects: { p1: p(false) } })).toBeNull();
    expect(presentOnboarding({ ...store, projects: { p1: p(true) } })).not.toBeNull();
  });
  it('確かめる前は、確かめている最中と出す', () => {
    expect(presentOnboarding({ ...initialStore(), bootstrapped: true })).toEqual({ checks: null });
  });
});

describe('空のホームの確認リスト（初回の A1）', () => {
  const renderHome = (onIntent = vi.fn()) => {
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...emptyHome} onboarding={presentOnboarding({ ...initialStore(), bootstrapped: true, readiness: READY })} /></IntentRoot>);
    return onIntent;
  };
  it('真ん中に 1 枚の札を置き、5 つの ✓ と ✗、揃った数を出す。ふだんのホームの区画は出さない', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: 'ようこそ' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: '始める前の確認' });
    expect(within(card).getByText('5 つ中 2 つ')).toBeInTheDocument();
    expect(within(card).getAllByRole('listitem')).toHaveLength(5);
    expect(within(card).getByText('/opt/homebrew/bin/tmux（3.4）')).toBeInTheDocument();
    expect(within(card).getByText('/Users/me/workspace の直下に、Claude のセッションがあるディレクトリがありません')).toBeInTheDocument();
    expect(within(card).getByText('tmux と claude があれば、残りが ✗ でも始められます')).toBeInTheDocument();
    expect(screen.queryByText('最近')).toBeNull();
  });
  it('✓ と ✗ は印だけでなく、読み上げの名前でも分かる', () => {
    renderHome();
    expect(screen.getByRole('listitem', { name: 'tmux 準備できています' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'ワークスペース まだです' })).toBeInTheDocument();
  });
  it('コマンドはコピーでき、設定で直すものは設定へ、もう一度確かめられる', () => {
    const onIntent = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'hangar mcp install をコピー' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: 'hangar mcp install' });
    fireEvent.click(screen.getByRole('button', { name: '設定で変える' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'nav.go', to: { name: 'settings' } });
    fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'readiness.check' });
  });
  it('下の 3 つのボタンは、スクラッチ、新しいセッション、設定を開く', () => {
    const onIntent = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'スクラッチで始める' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', scratch: true });
    fireEvent.click(screen.getByRole('button', { name: '新しいセッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open' });
    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }));
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'nav.go', to: { name: 'settings' } });
  });
  it('確かめる前は札の中に確かめている最中と出す', () => {
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...emptyHome} onboarding={{ checks: null }} /></IntentRoot>);
    expect(screen.getByText('確かめています')).toBeInTheDocument();
  });
});
