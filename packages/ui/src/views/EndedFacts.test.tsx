import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction, type SessionDto } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { presentLeadCard, type LeadInput } from '../presenters/session.ts';
import { EndedFacts } from './EndedFacts.tsx';
import { SummaryCard } from './SummaryCard.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const ja = translator('ja');
const en = translator('en');
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const DAY = 86_400_000;

const session = (p: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u', projectId: 'p1', name: '画像の遅延読み込み', cwd: '/w/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOW - 4 * DAY, lastActivityAt: NOW - 3 * DAY, lastTurnAt: null, 
  hasTranscript: true, live: null,
  summary: { title: 't', oneLiner: 'o', body: '商品一覧の画像を遅延読み込みにした。', state: 'done', nextSteps: ['詳細の頁の画像にも同じ部品を使う'], source: 'post_hoc', sourceId: null, sourceModel: null, basedOnTurns: 11, updatedAt: NOW - 3 * DAY },
  stats: { turns: 11, model: null, effort: null, filesChanged: 3, prUrl: 'https://github.com/o/r/pull/88', inputTokens: 12_000, outputTokens: 8_000, contextPercent: null, costUsd: 0.42 },
  fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null,
  state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: NOW - 3 * DAY, candidate: null }, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, unread: null, spawnedBy: null, ...p,
});
const art = (id: string, p: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: `成果 ${id}`, description: null, icon: 'document', url: 'https://x', lastPublished: '3 日前', versionCount: 1, canOpenEditor: false, ...p });
const input = (p: Partial<LeadInput> = {}): LeadInput => ({
  session: session(), now: NOW, gone: false, summaryPending: false, summaryError: null, artifacts: [art('a1')],
  files: [{ path: '/w/web-shop/src/ProductImage.tsx', edits: 3, agentId: null }, { path: '/w/web-shop/src/products.tsx', edits: 1, agentId: 'abc' }, { path: '/w/web-shop/NOTES.md', edits: 1, agentId: null }],
  windowFiles: [{ path: '/w/web-shop/src/ProductImage.tsx', dir: 'src/', base: 'ProductImage.tsx', added: 52, removed: 18, created: false }, { path: '/w/web-shop/NOTES.md', dir: '', base: 'NOTES.md', added: 3, removed: 0, created: true }],
  ...p,
});

function mount(p: Partial<LeadInput> = {}, language: 'ja' | 'en' = 'ja') {
  const onAction = vi.fn<(i: UiAction) => void>();
  const ui = (q: Partial<LeadInput> = {}) => {
    const lead = presentLeadCard(input({ ...p, ...q }), language === 'ja' ? ja : en);
    return <LanguageRoot language={language}><ActionRoot onAction={onAction}><EndedFacts sessionId="s1" {...lead} /><SummaryCard sessionId="s1" {...lead} /></ActionRoot></LanguageRoot>;
  };
  const view = render(ui());
  return { onAction, rerender: (q: Partial<LeadInput>) => view.rerender(ui(q)) };
}
const facts = () => screen.getByRole('group', { name: 'このセッションのまとめ' });
const card = () => screen.getByRole('region', { name: '要約' });

describe('見出しの下の 1 行（H1）', () => {
  it('自動で付いた Done の札は、頭に ✦ を置き、理由をツールチップで言う', () => {
    mount({ session: session({ state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'import', setAt: NOW - DAY, candidate: null }, stats: { ...session().stats, turns: 2 } }) });
    const tag = facts().querySelector('.lead-status')!;
    expect(tag).toHaveAttribute('data-auto', 'true');
    expect(tag.querySelector('.icon')).toHaveAttribute('data-icon', 'autoMark');
    expect(tag).toHaveAttribute('title', 'hangar が自動で Done にしました（3 ターン以下で終了した会話）');
  });
  it('ステータスの札、設定した日、終了、ターンとトークンとコストを 1 行に並べる。要約の本文はここに無い', () => {
    mount();
    const c = within(facts());
    expect(c.getByText('Done')).toHaveAttribute('data-s', 'done');
    // 札の語は英語のまま、日本語の説明をツールチップで添える。
    expect(c.getByText('Done')).toHaveAttribute('title', '完了したもの');
    expect(c.getByText(/に設定$/)).toBeInTheDocument();
    expect(c.getByText('最終メッセージ 3 日前')).toBeInTheDocument();
    expect(c.getByText('11 ターン')).toBeInTheDocument();
    expect(c.getByText('20k トークン')).toBeInTheDocument();
    expect(c.getByText('$0.42')).toBeInTheDocument();
    expect(c.queryByText('商品一覧の画像を遅延読み込みにした。')).toBeNull();
    expect(c.queryByRole('button', { name: '要約を再生成' })).toBeNull();
  });
  it('区切りを付けたので止めたときは、終了の代わりにその知らせを出す', () => {
    mount({ session: session({ stoppedByStatus: true, state: { status: 'paused', note: null, returnOn: '2026-10-12', returnTime: null, setBy: 'user', setAt: NOW, candidate: null } }) });
    expect(within(facts()).getByText('Paused にしたため停止しました。再開すると続けられます')).toBeInTheDocument();
    expect(within(facts()).queryByText(/^終了/)).toBeNull();
  });
  it('本文が消えた会話は「要約のみ」と言う', () => {
    mount({ gone: true });
    expect(within(facts()).getByText('要約のみ')).toBeInTheDocument();
  });
  it('ノートの欄も「ノートを書く」のボタンも無い（ノートは 0.4.0 で外した）', () => {
    mount();
    expect(within(facts()).queryByRole('textbox')).toBeNull();
    expect(within(facts()).queryByRole('button', { name: /ノート/ })).toBeNull();
  });
});

describe('見出しの下の 1 行の札', () => {
  it('変更したファイルの札は、件数の名前で、押すと 1 行の下へ一覧が開く。もう一度押すと閉じる', () => {
    const m = mount();
    const chip = within(facts()).getByRole('button', { name: '変更したファイル 3' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(within(facts()).queryByRole('region', { name: '変更したファイル' })).toBeNull();
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const panel = within(facts()).getByRole('region', { name: '変更したファイル' });
    expect(chip).toHaveAttribute('aria-controls', panel.id);
    // ファイルの 3 行と、差分のダイアログの入口（git の表示）。
    expect(within(panel).getAllByRole('button')).toHaveLength(4);
    fireEvent.click(within(panel).getByRole('button', { name: '差分を表示' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'diff.open', sessionId: 's1' });
    fireEvent.click(chip);
    expect(within(facts()).queryByRole('region', { name: '変更したファイル' })).toBeNull();
  });

  it('ファイルの行は、足した行と消した行（窓にある分だけ）、新規の印、サブエージェントの名を出し、押すと VS Code で開く', () => {
    const m = mount();
    fireEvent.click(within(facts()).getByRole('button', { name: '変更したファイル 3' }));
    const panel = within(facts()).getByRole('region', { name: '変更したファイル' });
    const first = within(panel).getByRole('button', { name: '/w/web-shop/src/ProductImage.tsx を VS Code で開く' });
    expect(first).toHaveTextContent('src/ProductImage.tsx');
    expect(first).toHaveTextContent('+52');
    expect(first).toHaveTextContent('−18');
    const second = within(panel).getByRole('button', { name: '/w/web-shop/src/products.tsx を VS Code で開く' });
    expect(second).toHaveTextContent('サブエージェント abc');
    expect(second).toHaveTextContent('1 回');
    expect(within(panel).getByRole('button', { name: '/w/web-shop/NOTES.md を VS Code で開く' })).toHaveTextContent('新規');
    expect(within(panel).getByText('追加した行と削除した行は、読み込んだ範囲のみ表示しています')).toBeInTheDocument();
    fireEvent.click(first);
    expect(m.onAction).toHaveBeenCalledWith({ type: 'session.openFile', sessionId: 's1', path: '/w/web-shop/src/ProductImage.tsx' });
  });

  it('アーティファクトの札を押すと一覧が開き、同時に開くのは 1 つだけ。題名で開き、鉛筆で VS Code', () => {
    const m = mount({ artifacts: [art('a1'), art('a2', { canOpenEditor: true })] });
    fireEvent.click(within(facts()).getByRole('button', { name: '変更したファイル 3' }));
    fireEvent.click(within(facts()).getByRole('button', { name: 'アーティファクト 2' }));
    expect(within(facts()).queryByRole('region', { name: '変更したファイル' })).toBeNull();
    const panel = within(facts()).getByRole('region', { name: 'アーティファクト' });
    fireEvent.click(within(panel).getByRole('button', { name: /成果 a1/ }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'artifact.open', id: 'a1' });
    fireEvent.click(within(panel).getByRole('button', { name: '成果 a2 を VS Code で開く' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'artifact.openEditor', id: 'a2' });
  });

  it('変更もアーティファクトも無ければ、その札を出さない', () => {
    mount({ files: [], artifacts: [], session: session({ stats: { ...session().stats, filesChanged: 0 } }) });
    expect(within(facts()).queryByRole('button', { name: /^変更したファイル/ })).toBeNull();
    expect(within(facts()).queryByRole('button', { name: /^アーティファクト/ })).toBeNull();
  });

  it('PR は、番号つきのリンクで、外のブラウザで開く', () => {
    mount();
    const pr = within(facts()).getByRole('link', { name: 'PR #88' });
    expect(pr).toHaveAttribute('href', 'https://github.com/o/r/pull/88');
    expect(pr).toHaveAttribute('target', '_blank');
    expect(pr).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });
});

describe('要約の札（S5）', () => {
  it('本文、次のステップ、進捗を出し、作成元は進捗の title で読める', () => {
    mount();
    const c = within(card());
    expect(c.getByText('商品一覧の画像を遅延読み込みにした。')).toBeInTheDocument();
    expect(c.getByText('次のステップ')).toBeInTheDocument();
    expect(c.getByText('詳細の頁の画像にも同じ部品を使う')).toBeInTheDocument();
    expect(c.getByText('進捗 完了、11 ターン時点')).toHaveAttribute('title', expect.stringMatching(/^作成元 事後、/));
    expect(c.queryByText(/^作成元/)).toBeNull();
  });
  it('「要約を再生成」で summary.regenerate を出す。本文が消えた会話では出さない', () => {
    const m = mount();
    fireEvent.click(within(card()).getByRole('button', { name: '要約を再生成' }));
    expect(m.onAction).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: 's1' });
    m.rerender({ gone: true });
    expect(within(card()).queryByRole('button', { name: '要約を再生成' })).toBeNull();
  });
  it('土台の要約（索引が組んだ事実）だけなら、札を出さない。「要約はありません」も「設定で有効に」も言わない', () => {
    const baseline = { title: 't', oneLiner: 'o', body: '最初の依頼：画像を遅延読み込みに', state: 'done' as const, nextSteps: [], source: 'baseline' as const, sourceId: null, sourceModel: null, basedOnTurns: 5, updatedAt: NOW - 3 * DAY };
    mount({ session: session({ summary: baseline }), summaryOff: true });
    expect(screen.queryByRole('region', { name: '要約' })).toBeNull();
    expect(screen.queryByText('最初の依頼：画像を遅延読み込みに')).toBeNull();
    expect(document.body).not.toHaveTextContent('要約は設定で有効にできます');
    expect(screen.queryByText('要約はありません')).toBeNull();
  });
  it('要約が無くても、作成中と失敗は札に出す。失敗の理由は title に持つ', () => {
    const m = mount({ session: session({ summary: null }) });
    expect(screen.queryByRole('region', { name: '要約' })).toBeNull();
    m.rerender({ session: session({ summary: null }), summaryPending: true });
    expect(within(card()).getByText('要約を作成中…')).toBeInTheDocument();
    m.rerender({ session: session({ summary: null }), summaryError: 'LM Studio に届かない' });
    expect(within(card()).getByText('要約を作成できませんでした')).toHaveAttribute('title', 'LM Studio に届かない');
  });
});

describe('見出しの下の 1 行と要約の札の英語', () => {
  it('辞書の英語の文が出る', () => {
    mount({}, 'en');
    const f = within(screen.getByRole('group', { name: 'Summary of this session' }));
    expect(f.getByRole('button', { name: 'Changed files 3' })).toBeInTheDocument();
    const c = within(screen.getByRole('region', { name: 'Summary' }));
    expect(c.getByRole('button', { name: 'Regenerate summary' })).toBeInTheDocument();
    expect(c.getByText('Next steps')).toBeInTheDocument();
  });
});
