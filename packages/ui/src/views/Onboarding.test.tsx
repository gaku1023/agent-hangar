import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompatDto, ReadinessDto } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import type { HomeScreenProps } from '../presenters/home.ts';
import { presentOnboarding } from '../presenters/onboarding.ts';
import { initialStore } from '../store/store.ts';
import { HomeScreen } from './HomeScreen.tsx';

const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash x', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};
/** 空のホームに渡す props。確認リストを出すときは、帯も一覧も描かない。 */
const home = (onboarding: HomeScreenProps['onboarding']): HomeScreenProps => ({ band: { groups: [], morning: null }, idle: true, searching: false, list: { text: '', filter: {}, projects: [], rows: [], total: 0, loading: false, mode: 'all', conditions: [], tabs: [], tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], allCount: 0 }, allCount: 0, loadMore: null, onboarding });

describe('presentOnboarding', () => {
  it('セッションもプロジェクトも無いときだけ出す。スクラッチのプロジェクトは数えない', () => {
    const store = { ...initialStore(), bootstrapped: true, readiness: READY };
    expect(presentOnboarding(store)).toMatchObject({ checks: { progress: '6 つ中 3 つ' } });
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
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home(presentOnboarding({ ...initialStore(), bootstrapped: true, readiness: READY }))} /></IntentRoot>);
    return onIntent;
  };
  it('真ん中に 1 枚の札を置き、6 つの ✓ と ✗、揃った数を出す。ふだんのホームの区画は出さない', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: 'ようこそ' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: '始める前の確認' });
    expect(within(card).getByText('6 つ中 3 つ')).toBeInTheDocument();
    expect(within(card).getAllByRole('listitem')).toHaveLength(6);
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
    render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ checks: null })} /></IntentRoot>);
    expect(screen.getByText('確かめています')).toBeInTheDocument();
  });
});

describe('確認リストの 6 行目（Claude Code との互換）', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const DETAIL: CompatDto = {
    verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [
      { contract: 'screen', value: 'prompt-marker=(missing)', version: '2.1.300', count: 2, firstSeenAt: at(7, 14, 2), lastSeenAt: at(7, 14, 9) },
      { contract: 'registry', value: 'status=compacting', version: '2.1.300', count: 5, firstSeenAt: at(7, 13, 40), lastSeenAt: at(7, 14, 5) },
      { contract: 'transcript', value: 'system.subtype=turn_summary', version: '2.1.298', count: 9, firstSeenAt: at(6, 22, 15), lastSeenAt: at(7, 14, 1) },
    ],
  };
  const DRIFT = { verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 3 };
  const storeWith = (compat: ReadinessDto['compat'], full: CompatDto | null) => ({ ...initialStore(), bootstrapped: true, version: '0.3.0', readiness: { ...READY, compat }, compat: full });
  const renderWith = (compat: ReadinessDto['compat'], full: CompatDto | null = null, onIntent = vi.fn()) => {
    render(<IntentRoot onIntent={onIntent}><HomeScreen {...home(presentOnboarding(storeWith(compat, full)))} /></IntentRoot>);
    return onIntent;
  };
  it('問題なしは緑の ✓ で、確かめた版を添え、済んだものに数える', () => {
    renderWith({ verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 });
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれはありません' });
    expect(row).toHaveAttribute('data-tone', 'ok');
    expect(within(row).getByText('ずれなし（2.1.292 で確かめた版）')).toBeInTheDocument();
    expect(within(row).getByText('hangar が読む Claude Code の形を見張っています')).toBeInTheDocument();
    expect(screen.getByText('6 つ中 3 つ')).toBeInTheDocument();
  });
  it('未確認の版は灰色の ⓘ で、止めていないので済んだものに数える', () => {
    renderWith({ verifiedVersion: '2.1.292', localVersion: '2.1.300', driftCount: 0 });
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 まだ確かめていない版です' });
    expect(row).toHaveAttribute('data-tone', 'info');
    // 印は色だけでなく形（ⓘ）でも分ける。
    expect(row.querySelector('[data-icon="info"]')).not.toBeNull();
    expect(within(row).getByText('2.1.300（確かめた版は 2.1.292）')).toBeInTheDocument();
    expect(within(row).getByText('まだ確かめていない版です。動きは止めていません')).toBeInTheDocument();
    expect(screen.getByText('6 つ中 3 つ')).toBeInTheDocument();
  });
  it('ずれは注意の色で、止めた機能を常に出し、細目は「ずれ N 件の中身」で畳む。6 つ中には数えない', () => {
    renderWith(DRIFT, DETAIL);
    expect(screen.getByText('6 つ中 2 つ')).toBeInTheDocument();
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれがあります' });
    expect(row).toHaveAttribute('data-tone', 'soft');
    expect(within(row).getByText('ずれ 3 件（2.1.300）')).toBeInTheDocument();
    expect(within(row).getByText('知らない形に頼る機能だけを止め、ほかは動かしています')).toBeInTheDocument();
    const stops = within(row).getByRole('list', { name: '止めた機能' });
    expect(within(stops).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ターンの目次から端末の指示へ跳ぶのを止めています', '休んでいるセッションを自動で止めるのを控えています']);
    const more = within(row).getByText('ずれ 3 件の中身').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    const rows = within(more).getAllByRole('row').map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['契約', '値', '版', '最初に見た', '止めた機能'],
      ['画面の文字', 'prompt-marker=(missing)', '2.1.300', '10/07 14:02', '目次から跳ぶ'],
      ['レジストリ', 'status=compacting', '2.1.300', '10/07 13:40', '休みで止める'],
      ['トランスクリプト', 'system.subtype=turn_summary', '2.1.298', '10/06 22:15', 'なし'],
    ]);
  });
  it('表の下に記録の置き場を書き、報告用に写すで、ずれの一覧を写す', () => {
    const onIntent = renderWith(DRIFT, DETAIL);
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれがあります' });
    expect(within(row).getByText('~/.agent-hangar/compat.json')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '報告用に写す' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'clipboard.copy', text: presentOnboarding(storeWith(DRIFT, DETAIL))!.checks!.items.at(-1)!.compat!.report });
  });
  it('ずれの中身が届く前は、件数と読み込み中だけを出し、表も写すボタンも出さない', () => {
    renderWith(DRIFT, null);
    const row = screen.getByRole('listitem', { name: 'Claude Code との互換 ずれがあります' });
    expect(within(row).getByText('ずれの中身を読み込んでいます')).toBeInTheDocument();
    expect(within(row).queryByRole('table')).toBeNull();
    expect(within(row).queryByRole('button', { name: '報告用に写す' })).toBeNull();
  });
});
