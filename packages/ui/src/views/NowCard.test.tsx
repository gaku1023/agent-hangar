import { fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type UiAction, type LiveAgentDto, type TranscriptEvent } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentNowCard, type CardInput } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import * as nowCardModule from './NowCard.tsx';
import { NowCard } from './NowCard.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import { useCardHeight } from './useCardHeight.ts';

// 札の背の決め方そのものは useCardHeight.test で見る。ここでは、札が何を節目の鍵として渡すかだけを見る。
vi.mock('./useCardHeight.ts', async (original) => {
  const m = await original<typeof import('./useCardHeight.ts')>();
  return { ...m, useCardHeight: vi.fn(m.useCardHeight) };
});
/** 直近の描画で札が useCardHeight に渡した（セッション、節目の鍵）。 */
const heightArgs = () => vi.mocked(useCardHeight).mock.calls.at(-1)!;

const ja = translator('ja');
const en = translator('en');

let seq = 0;
const call = (name: string, input: unknown): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ts: 0, toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError: false });
const agent = (p: Partial<LiveAgentDto>): LiveAgentDto => ({ agentId: 'a', title: '担当', state: 'running', startedAt: 0, lastAt: 60_000, last: null, report: null, endNote: null, linked: true, ...p });
const art = (id: string, p: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: `成果 ${id}`, description: null, favicon: '📄', url: 'https://x', lastPublished: '12 分前', versionCount: 1, canOpenEditor: false, ...p });
const input = (p: Partial<CardInput> = {}): CardInput => ({
  digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] }, events: [], turnFrom: 0, live: 'waiting',
  activity: { tool: 'AskUserQuestion', summary: 'q', question: '既存のテストを書き換えてよいですか？' }, now: 120_000, viewingAgent: false, clock: () => '10:01', idleFor: '3 分',
  waited: '4 分', artifacts: [], ...p,
});

function mount(p: Partial<CardInput> = {}, language: 'ja' | 'en' = 'ja') {
  const onAction = vi.fn<(i: UiAction) => void>();
  const card = (q: Partial<CardInput>) => presentNowCard(input({ ...p, ...q }), language === 'ja' ? ja : en);
  const ui = (q: Partial<CardInput> = {}, sessionId = 's1') => (
    <LanguageRoot language={language}><ActionRoot onAction={onAction}><NowCard sessionId={sessionId} {...card(q)} /></ActionRoot></LanguageRoot>
  );
  const view = render(ui());
  return { onAction, rerender: (q: Partial<CardInput>, sessionId?: string) => view.rerender(ui(q, sessionId)), container: view.container };
}
const card = () => screen.getByRole('region', { name: 'セッションの現在の状態' });

describe('現在の札の止まっている理由の欄', () => {
  it('許可待ちは盾と、命令の全文と答え方を出す', () => {
    const view = mount({ activity: null, reason: 'permission', permission: { tool: 'Bash', input: 'rm -rf ./build/cache', description: '古いキャッシュを消す' } });
    const card = view.container.querySelector('.now-card')!;
    expect(card.querySelector('.reason-glyph[data-reason="permission"]')).not.toBeNull();
    expect(within(card as HTMLElement).getByRole('status').textContent).toBe('許可待ち');
    expect(card.querySelector('.nc-stop-cmd')?.textContent).toBe('rm -rf ./build/cache');
    expect(card.textContent).toContain('ターミナルで許可するか拒否してください');
  });
  it('使用制限は砂時計と、リセットの時刻と残りの棒を出す', () => {
    const now = new Date(2026, 9, 12, 16, 42).getTime();
    const view = mount({ activity: null, live: 'idle', now, reason: 'limit', limit: { kind: 'five_hour', resetsAt: new Date(2026, 9, 12, 16, 50).getTime(), auto: false, reset: false } });
    const card = view.container.querySelector('.now-card')!;
    expect(card.getAttribute('data-tone')).toBe('limit');
    expect(card.querySelector('.reason-glyph[data-reason="limit"]')).not.toBeNull();
    expect(card.querySelector('.nc-stop-at')?.textContent).toBe('16:50 にリセット（あと 8 分）');
    expect(card.querySelector('.nc-stop-meter > i')).not.toBeNull();
  });
});

describe('NowCard の状態の行', () => {
  it('札は region で、状態の語だけを知らせの領域（role="status"）にする', () => {
    mount();
    expect(card()).not.toHaveAttribute('role', 'status');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('入力待ち');
    expect(card().contains(status)).toBe(true);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('入力待ちは、待機の経過と、「Claude の問い」の見出しつきで問いを出し、色を tone に出す', () => {
    mount();
    expect(card()).toHaveAttribute('data-tone', 'wait');
    expect(within(card()).getByText('4 分')).toBeInTheDocument();
    const q = within(card()).getByText('既存のテストを書き換えてよいですか？').closest('.nc-question')!;
    expect(q).toHaveTextContent('Claude の問い');
  });

  it('作業中、アイドル、裏だけ動いている、の灯の色を替える。裏の 1 行は問いの見出しを付けない', () => {
    const m = mount({ live: 'busy', activity: null });
    expect(card()).toHaveAttribute('data-tone', 'busy');
    expect(card().querySelector('.live-dot')).toHaveAttribute('data-tone', 'busy');
    m.rerender({ live: 'idle', activity: null });
    expect(card()).toHaveAttribute('data-tone', 'idle');
    m.rerender({ live: 'busy', activity: null, aside: { shell: true, agents: 0 } });
    expect(card()).toHaveAttribute('data-tone', 'aside');
    expect(screen.getByRole('status')).toHaveTextContent('バックグラウンドで作業中');
    expect(within(card()).getByText('シェルが実行中、メイン会話は入力を受け付けている')).toBeInTheDocument();
    expect(card().querySelector('.nc-question')).toBeNull();
  });

  it('札には、コンテキスト使用量、コスト、ターン、トークン、ノートを置かない（見出しの (i) と札へ移した）', () => {
    mount({ live: 'busy', activity: null });
    expect(within(card()).queryByRole('meter')).toBeNull();
    expect(within(card()).queryByRole('button', { name: /^ノート/ })).toBeNull();
  });

  it('英語では、辞書の英語の文が出る', () => {
    mount({}, 'en');
    expect(screen.getByRole('region', { name: 'Current state of this session' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Needs input');
    expect(screen.getByText('Claude asks')).toBeInTheDocument();
  });
});

describe('NowCard の背の節目', () => {
  it('中身は .nc-body に包み、札の背はセッションと節目の鍵で決めさせる', () => {
    mount();
    expect(card().firstElementChild).toHaveClass('nc-body');
    expect(card().querySelector('.nc-body > .nc-head')).not.toBeNull();
    expect(heightArgs()[0]).toBe('s1');
  });

  it('状態の色が替わったときと、問いが出入りしたときに鍵を替える', () => {
    seq = 0;
    const r = call('Read', { file_path: '/w/a.ts' });
    const m = mount({ live: 'busy', activity: null, events: [r] });
    const busy = heightArgs()[1];
    m.rerender({ live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: '進めてよいですか？' }, events: [r, res(r)] });
    expect(card().querySelector('.nc-question')).not.toBeNull();
    const asked = heightArgs()[1];
    expect(asked).not.toBe(busy);
    m.rerender({ live: 'waiting', activity: null, events: [r, res(r)] });
    const waiting = heightArgs()[1];
    expect(waiting).not.toBe(asked);
    m.rerender({ live: 'busy', activity: null, aside: { shell: true, agents: 0 }, events: [r, res(r)] });
    expect(heightArgs()[1]).not.toBe(waiting);
  });

  it('サブエージェントの 1 行が出入りしたときに鍵を替える', () => {
    seq = 0;
    const r = call('Read', { file_path: '/w/a.ts' });
    const digest = { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [agent({ agentId: 'a' })] };
    const m = mount({ live: 'busy', activity: null, digest, events: [r] });
    expect(card().querySelector('.nc-detail')).not.toBeNull();
    const withLine = heightArgs()[1];
    m.rerender({ live: 'busy', activity: null, digest, events: [r, res(r)] });
    expect(card().querySelector('.nc-detail')).toBeNull();
    expect(heightArgs()[1]).not.toBe(withLine);
  });

  it('中身だけが替わる間（手が増える、意図が替わる）は鍵を替えない', () => {
    seq = 0;
    const a = call('Read', { file_path: '/w/a.ts' });
    const b = call('Read', { file_path: '/w/b.ts' });
    const m = mount({ live: 'busy', activity: null, events: [a] });
    const key = heightArgs()[1];
    m.rerender({ live: 'busy', activity: null, events: [a, res(a), b] });
    m.rerender({ live: 'busy', activity: null, events: [a, res(a), b], digest: { sessionId: 's1', turnStartSeq: 0, intent: { text: '直す', at: 0, stepsSince: 0, inThisTurn: true }, agents: [] } });
    expect(heightArgs()[1]).toBe(key);
  });

  it('新しいターンの始まり（作業中で手がまだ無い）は節目にせず、手が埋まっても鍵を保つ', () => {
    seq = 0;
    const m = mount({ live: 'waiting', activity: null });
    const ended = heightArgs()[1];
    m.rerender({ live: 'busy', activity: null, events: [] });
    expect(heightArgs()[1]).toBe(ended);
    const r = call('Read', { file_path: '/w/a.ts' });
    m.rerender({ live: 'busy', activity: null, events: [r] });
    expect(heightArgs()[1]).toBe(ended);
    // 次の節目（ターンの終わり）では替わる。
    m.rerender({ live: 'waiting', activity: null, events: [r, res(r)] });
    expect(heightArgs()[1]).not.toBe(ended);
  });

  it('セッションが替わったら、そのセッションを渡す', () => {
    const m = mount();
    m.rerender({}, 's2');
    expect(heightArgs()[0]).toBe('s2');
  });
});

describe('NowCard の意図', () => {
  it('今のターンの意図を、引用符なしの全文で出し、「Claude の意図 · 時刻」の小見出しを添える。無ければ「まだ意図が届いていません」', () => {
    const m = mount({ digest: { sessionId: 's1', turnStartSeq: 0, intent: { text: '検証をサーバ側へ寄せる', at: 0, stepsSince: 3, inThisTurn: true }, agents: [] } });
    const intent = card().querySelector('.nc-intent')!;
    expect(intent).toHaveTextContent('Claude の意図 · 10:01');
    expect(within(intent as HTMLElement).getByText('検証をサーバ側へ寄せる')).toBeInTheDocument();
    expect(intent).toHaveAttribute('title', 'Claude が記入、10:01、以降のツール呼び出し 3 回');
    expect(intent.textContent).not.toContain('「');
    m.rerender({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] } });
    expect(within(card()).getByText('まだ意図が届いていません')).toBeInTheDocument();
  });

  it('30 回を超えた意図は、薄くする印を付ける', () => {
    mount({ digest: { sessionId: 's1', turnStartSeq: 0, intent: { text: 'x', at: 0, stepsSince: 31, inThisTurn: true }, agents: [] } });
    expect(card().querySelector('.nc-intent')).toHaveAttribute('data-stale', 'true');
  });
});

describe('NowCard のツール呼び出し', () => {
  it('直近のツール呼び出しを縦に並べ、説明を先に、道具の名前を後ろに出す。状態は形と読み上げの語で言う', () => {
    seq = 0;
    const r = call('Read', { file_path: '/w/src/checkout/form.ts' });
    const q = call('AskUserQuestion', { questions: [] });
    mount({ events: [r, res(r), q] });
    const list = within(card()).getByRole('list', { name: 'ツール呼び出し' });
    const items = within(list).getAllByRole('listitem');
    // 済んだ呼び出しの読み上げの語は「済」。要約の進捗の「完了」と分ける（2026-10-13 の決定）。
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['✓済 form.ts Read', '●入力待ち AskUserQuestion']);
    expect(items[1]).toHaveAttribute('data-mark', 'wait');
  });

  it('呼び出しが 3 つを超えるときだけ「ほか N」の札を出し、押すと直近 30 回までが開く', () => {
    seq = 0;
    const events: TranscriptEvent[] = [];
    for (let n = 0; n < 5; n++) { const c = call('Read', { file_path: `/w/f${n}.ts` }); events.push(c, res(c)); }
    const m = mount({ events, live: 'idle', activity: null });
    expect(within(card()).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(within(card()).getByRole('button', { name: 'ほか 2' }));
    const dialog = screen.getByRole('dialog', { name: 'ツール呼び出し' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    m.rerender({ events: events.slice(0, 6), live: 'idle', activity: null });
    expect(within(card()).queryByRole('button', { name: /^ほか/ })).toBeNull();
  });

  it('描いた後に増えた呼び出しだけに、入ってくる印（data-new）を付ける。開いた直後とセッションを替えた直後は付けない', () => {
    seq = 0;
    const a = call('Read', { file_path: '/w/a.ts' });
    const b = call('Read', { file_path: '/w/b.ts' });
    const m = mount({ events: [a, res(a)], live: 'busy', activity: null });
    expect(card().querySelectorAll('[data-new]')).toHaveLength(0);
    m.rerender({ events: [a, res(a), b], live: 'busy', activity: null });
    const fresh = [...card().querySelectorAll('[data-new]')];
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toHaveTextContent('b.ts');
    m.rerender({ events: [a, res(a), b, res(b), call('Read', { file_path: '/w/c.ts' })], live: 'busy', activity: null }, 's2');
    expect(card().querySelectorAll('[data-new]')).toHaveLength(0);
  });

  it('サブエージェントの札は、1 本も無ければ出さない。あれば件数の名前で、押すと 1 本ずつの一覧が開く', () => {
    const m = mount();
    expect(within(card()).queryByRole('button', { name: /^サブエージェント/ })).toBeNull();
    m.rerender({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [agent({ agentId: 'a', title: 'テストの一覧を集める', state: 'done', report: 'checkout/ の 12 件を列挙した' }), agent({ agentId: 'b', title: '型を直す', linked: false })] } });
    const chip = within(card()).getByRole('button', { name: 'サブエージェント 2' });
    expect(chip.querySelector('.live-dot')).toHaveAttribute('data-tone', 'running');
    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: 'サブエージェント' });
    const rows = within(dialog).getAllByRole('button');
    expect(rows).toHaveLength(2);
    // 実行中が先、完了が後。本文を持たない（linked でない）本は押せない。
    expect(rows[0]).toHaveTextContent('型を直す');
    expect(rows[0]).toBeDisabled();
    expect(rows[1]).toHaveTextContent('「checkout/ の 12 件を列挙した」');
  });

  it('サブエージェントの行を押すと、その transcript へ切り替える UiAction を出して閉じる', () => {
    const m = mount({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [agent({ agentId: 'abc123', title: 'テストの一覧を集める' })] } });
    fireEvent.click(within(card()).getByRole('button', { name: 'サブエージェント 1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /テストの一覧を集める/ }));
    expect(m.onAction).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc123' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('アーティファクトの札は、件数の名前で、押すと一覧が開く。題名で開き、鉛筆で VS Code', () => {
    const m = mount({ artifacts: [art('a1'), art('a2', { canOpenEditor: true })] });
    fireEvent.click(within(card()).getByRole('button', { name: 'アーティファクト 2' }));
    const dialog = screen.getByRole('dialog', { name: 'アーティファクト' });
    expect(within(dialog).getAllByText(/最終公開 12 分前/)).toHaveLength(2);
    expect(within(dialog).getAllByRole('button', { name: /VS Code で開く/ })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: /成果 a1/ }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'artifact.open', id: 'a1' });
    fireEvent.click(screen.getByRole('button', { name: 'アーティファクト 2' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '成果 a2 を VS Code で開く' }));
    expect(m.onAction).toHaveBeenLastCalledWith({ type: 'artifact.openEditor', id: 'a2' });
  });

  it('アーティファクトが無ければ札を出さない', () => {
    mount();
    expect(within(card()).queryByRole('button', { name: /^アーティファクト/ })).toBeNull();
  });
});

describe('ノートの札', () => {
  it('見出しの「ノート」の札（NoteChip）は無い（ノートは 0.4.0 で外した）', () => {
    expect(nowCardModule).not.toHaveProperty('NoteChip');
    expect(presentNowCard(input(), ja)).not.toHaveProperty('note');
  });
});
