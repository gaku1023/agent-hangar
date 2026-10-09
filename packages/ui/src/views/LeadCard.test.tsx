import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type Intent, type SessionDto } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { presentLeadCard, type LeadInput } from '../presenters/session.ts';
import { LeadCard } from './LeadCard.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const ja = translator('ja');
const en = translator('en');
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const DAY = 86_400_000;

const session = (p: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u', projectId: 'p1', name: '画像の遅延読み込み', cwd: '/w/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOW - 4 * DAY, lastActivityAt: NOW - 3 * DAY, memo: null,
  hasTranscript: true, live: null,
  summary: { title: 't', oneLiner: 'o', body: '商品一覧の画像を遅延読み込みにした。', state: 'done', nextSteps: ['詳細の頁の画像にも同じ部品を使う'], source: 'post_hoc', sourceId: null, sourceModel: null, basedOnTurns: 11, updatedAt: NOW - 3 * DAY },
  stats: { turns: 11, model: null, effort: null, filesChanged: 3, prUrl: 'https://github.com/o/r/pull/88', inputTokens: 12_000, outputTokens: 8_000, contextPercent: null, costUsd: 0.42 },
  fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null,
  state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: NOW - 3 * DAY, candidate: null }, parked: false, stoppedByStatus: false, liveAside: null, ...p,
});
const art = (id: string, p: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: `成果 ${id}`, description: null, favicon: '📄', url: 'https://x', lastPublished: '3 日前', versionCount: 1, canOpenEditor: false, ...p });
const input = (p: Partial<LeadInput> = {}): LeadInput => ({
  session: session(), now: NOW, gone: false, summaryPending: false, summaryError: null, artifacts: [art('a1')],
  files: [{ path: '/w/web-shop/src/ProductImage.tsx', edits: 3, agentId: null }, { path: '/w/web-shop/src/products.tsx', edits: 1, agentId: 'abc' }, { path: '/w/web-shop/NOTES.md', edits: 1, agentId: null }],
  windowFiles: [{ path: '/w/web-shop/src/ProductImage.tsx', dir: 'src/', base: 'ProductImage.tsx', added: 52, removed: 18, created: false }, { path: '/w/web-shop/NOTES.md', dir: '', base: 'NOTES.md', added: 3, removed: 0, created: true }],
  ...p,
});

function mount(p: Partial<LeadInput> = {}, language: 'ja' | 'en' = 'ja') {
  const onIntent = vi.fn<(i: Intent) => void>();
  const ui = (q: Partial<LeadInput> = {}) => (
    <LanguageRoot language={language}><IntentRoot onIntent={onIntent}><LeadCard sessionId="s1" {...presentLeadCard(input({ ...p, ...q }), language === 'ja' ? ja : en)} /></IntentRoot></LanguageRoot>
  );
  const view = render(ui());
  return { onIntent, rerender: (q: Partial<LeadInput>) => view.rerender(ui(q)) };
}
const card = () => screen.getByRole('region', { name: 'このセッションのまとめ' });

describe('LeadCard の 1 行目', () => {
  it('ステータスの札、設定した日、終了、ターンとトークンとコスト、要約の進捗を出す', () => {
    mount();
    const c = within(card());
    expect(c.getByText('Done')).toHaveAttribute('data-s', 'done');
    expect(c.getByText(/に設定$/)).toBeInTheDocument();
    expect(c.getByText('終了 3 日前')).toBeInTheDocument();
    expect(c.getByText('11 ターン')).toBeInTheDocument();
    expect(c.getByText('20k トークン')).toBeInTheDocument();
    expect(c.getByText('$0.42')).toBeInTheDocument();
    expect(c.getByText('進捗 完了、11 ターン時点')).toBeInTheDocument();
  });

  it('区切りを付けたので止めたときは、終了の代わりにその知らせを出す', () => {
    mount({ session: session({ stoppedByStatus: true, state: { status: 'paused', note: null, returnOn: '2026-10-12', returnTime: null, setBy: 'user', setAt: NOW, candidate: null } }) });
    expect(within(card()).getByText('Paused にしたので停止しました。再開で続けられます')).toBeInTheDocument();
    expect(within(card()).queryByText(/^終了/)).toBeNull();
  });

  it('「要約を再生成」で summary.regenerate を出す。本文が消えた会話では出さず、「要約のみ」と言う', () => {
    const m = mount();
    fireEvent.click(within(card()).getByRole('button', { name: '要約を再生成' }));
    expect(m.onIntent).toHaveBeenCalledWith({ type: 'summary.regenerate', sessionId: 's1' });
    m.rerender({ gone: true });
    expect(within(card()).queryByRole('button', { name: '要約を再生成' })).toBeNull();
    expect(within(card()).getByText('要約のみ')).toBeInTheDocument();
  });
});

describe('LeadCard の要約', () => {
  it('本文、次のステップ、作成元の行を出す', () => {
    mount();
    const c = within(card());
    expect(c.getByText('商品一覧の画像を遅延読み込みにした。')).toBeInTheDocument();
    expect(c.getByText('次のステップ')).toBeInTheDocument();
    expect(c.getByText('詳細の頁の画像にも同じ部品を使う')).toBeInTheDocument();
    expect(c.getByText(/^作成元 事後、/)).toBeInTheDocument();
  });

  it('要約が無ければ「要約はありません」。作成中と失敗は注記にし、失敗の理由は title に持つ', () => {
    const m = mount({ session: session({ summary: null }) });
    expect(within(card()).getByText('要約はありません')).toBeInTheDocument();
    m.rerender({ session: session({ summary: null }), summaryPending: true });
    expect(within(card()).getByText('要約を作成しています')).toBeInTheDocument();
    m.rerender({ session: session({ summary: null }), summaryError: 'LM Studio に届かない' });
    expect(within(card()).getByText('要約を作成できませんでした')).toHaveAttribute('title', 'LM Studio に届かない');
  });
});

describe('LeadCard の札', () => {
  it('変更したファイルの札は、件数の名前で、押すとこの 1 枚の中へ一覧が開く。もう一度押すと閉じる', () => {
    mount();
    const chip = within(card()).getByRole('button', { name: '変更したファイル 3' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(within(card()).queryByRole('region', { name: '変更したファイル' })).toBeNull();
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const panel = within(card()).getByRole('region', { name: '変更したファイル' });
    expect(chip).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getAllByRole('button')).toHaveLength(3);
    fireEvent.click(chip);
    expect(within(card()).queryByRole('region', { name: '変更したファイル' })).toBeNull();
  });

  it('ファイルの行は、足した行と消した行（窓にある分だけ）、新規の印、サブエージェントの名を出し、押すと VS Code で開く', () => {
    const m = mount();
    fireEvent.click(within(card()).getByRole('button', { name: '変更したファイル 3' }));
    const panel = within(card()).getByRole('region', { name: '変更したファイル' });
    const first = within(panel).getByRole('button', { name: '/w/web-shop/src/ProductImage.tsx を VS Code で開く' });
    expect(first).toHaveTextContent('src/ProductImage.tsx');
    expect(first).toHaveTextContent('+52');
    expect(first).toHaveTextContent('−18');
    const second = within(panel).getByRole('button', { name: '/w/web-shop/src/products.tsx を VS Code で開く' });
    expect(second).toHaveTextContent('サブエージェント abc');
    expect(second).toHaveTextContent('1 回');
    expect(within(panel).getByRole('button', { name: '/w/web-shop/NOTES.md を VS Code で開く' })).toHaveTextContent('新規');
    expect(within(panel).getByText('足した行と消した行は、読み込んだ分だけ出ています')).toBeInTheDocument();
    fireEvent.click(first);
    expect(m.onIntent).toHaveBeenCalledWith({ type: 'session.openFile', sessionId: 's1', path: '/w/web-shop/src/ProductImage.tsx' });
  });

  it('アーティファクトの札を押すと一覧が開き、同時に開くのは 1 つだけ。題名で開き、鉛筆で VS Code', () => {
    const m = mount({ artifacts: [art('a1'), art('a2', { canOpenEditor: true })] });
    fireEvent.click(within(card()).getByRole('button', { name: '変更したファイル 3' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'アーティファクト 2' }));
    expect(within(card()).queryByRole('region', { name: '変更したファイル' })).toBeNull();
    const panel = within(card()).getByRole('region', { name: 'アーティファクト' });
    fireEvent.click(within(panel).getByRole('button', { name: /成果 a1/ }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'artifact.open', id: 'a1' });
    fireEvent.click(within(panel).getByRole('button', { name: '成果 a2 を VS Code で開く' }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'artifact.openEditor', id: 'a2' });
  });

  it('変更もアーティファクトも無ければ、その札を出さない', () => {
    mount({ files: [], artifacts: [], session: session({ stats: { ...session().stats, filesChanged: 0 } }) });
    expect(within(card()).queryByRole('button', { name: /^変更したファイル/ })).toBeNull();
    expect(within(card()).queryByRole('button', { name: /^アーティファクト/ })).toBeNull();
  });

  it('PR は、番号つきのリンクで、外のブラウザで開く', () => {
    mount();
    const pr = within(card()).getByRole('link', { name: 'PR #88' });
    expect(pr).toHaveAttribute('href', 'https://github.com/o/r/pull/88');
    expect(pr).toHaveAttribute('target', '_blank');
    expect(pr).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });
});

describe('LeadCard のノート', () => {
  it('ノートが空なら「ノートを書く」。押すとこの 1 枚の中で編集欄が開き、保存で session.setMemo を出す', () => {
    const m = mount();
    expect(within(card()).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'ノートを書く' }));
    const area = within(card()).getByRole('textbox', { name: 'ノート' });
    expect(area).toHaveFocus();
    fireEvent.change(area, { target: { value: '詳細の頁は別のセッションで' } });
    fireEvent.click(within(card()).getByRole('button', { name: '保存' }));
    expect(m.onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '詳細の頁は別のセッションで' });
  });

  it('ノートに中身があれば本文を出し、「ノートを編集」で編集欄を開く（今の本文が入っている）', () => {
    mount({ session: session({ memo: '詳細の頁は別のセッションで' }) });
    expect(within(card()).getByText('詳細の頁は別のセッションで')).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole('button', { name: 'ノートを編集' }));
    expect(within(card()).getByRole('textbox', { name: 'ノート' })).toHaveValue('詳細の頁は別のセッションで');
    expect(within(card()).queryByRole('button', { name: 'ノートを編集' })).toBeNull();
  });
  it('⌘Enter で保存すると session.setMemo を出して読む表示に戻り、Esc では保存せずに戻る', () => {
    const { onIntent } = mount({ session: session({ memo: '元' }) });
    fireEvent.click(within(card()).getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(within(card()).getByRole('textbox', { name: 'ノート' }), { target: { value: '新' } });
    fireEvent.keyDown(within(card()).getByRole('textbox', { name: 'ノート' }), { key: 'Enter', metaKey: true });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '新' });
    expect(within(card()).queryByRole('textbox')).toBeNull();
    onIntent.mockClear();
    fireEvent.click(within(card()).getByRole('button', { name: 'ノートを編集' }));
    fireEvent.keyDown(within(card()).getByRole('textbox', { name: 'ノート' }), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(within(card()).queryByRole('textbox')).toBeNull();
  });
});

describe('LeadCard の英語', () => {
  it('辞書の英語の文が出る', () => {
    mount({}, 'en');
    const c = within(screen.getByRole('region', { name: 'Summary of this session' }));
    expect(c.getByRole('button', { name: 'Regenerate summary' })).toBeInTheDocument();
    expect(c.getByText('Next steps')).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Changed files 3' })).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Write a note' })).toBeInTheDocument();
  });
});
