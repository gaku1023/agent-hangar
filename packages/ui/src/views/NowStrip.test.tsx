import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { translator, type Intent, type LiveAgentDto, type TranscriptEvent } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { presentNowStrip, type StripInput } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { NowStrip } from './NowStrip.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const ja = translator('ja');
const en = translator('en');

let seq = 0;
const call = (name: string, input: unknown): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ts: 0, toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError: false });
const agent = (p: Partial<LiveAgentDto>): LiveAgentDto => ({ agentId: 'a', title: '担当', state: 'running', startedAt: 0, lastAt: 60_000, last: null, report: null, endNote: null, linked: true, ...p });
const art = (id: string, p: Partial<ArtifactCardProps> = {}): ArtifactCardProps => ({ id, title: `成果 ${id}`, description: null, favicon: '📄', url: 'https://x', lastPublished: '12 分前', versionCount: 1, canOpenEditor: false, ...p });
const input = (p: Partial<StripInput> = {}): StripInput => ({
  digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] }, events: [], turnFrom: 0, turnNo: 9, live: 'waiting',
  activity: { tool: 'AskUserQuestion', summary: 'q', question: '既存のテストを書き換えてよいですか？' }, now: 120_000, viewingAgent: false, clock: () => '10:01', idleFor: '3 分',
  waited: '4 分', contextPercent: 41, cost: '$0.86', turns: 9, tokens: '31k', artifacts: [], note: null, ...p,
});

function mount(p: Partial<StripInput> = {}, language: 'ja' | 'en' = 'ja') {
  const onIntent = vi.fn<(i: Intent) => void>();
  const strip = (q: Partial<StripInput>) => presentNowStrip(input({ ...p, ...q }), language === 'ja' ? ja : en);
  const ui = (q: Partial<StripInput> = {}) => (
    <LanguageRoot language={language}><IntentRoot onIntent={onIntent}><NowStrip sessionId="s1" {...strip(q)} /></IntentRoot></LanguageRoot>
  );
  const view = render(ui());
  return { onIntent, rerender: (q: Partial<StripInput>) => view.rerender(ui(q)), container: view.container };
}
const strip = () => screen.getByRole('region', { name: 'セッションの現在の状態' });

describe('NowStrip の 1 行目', () => {
  it('帯は region で、状態の語だけを知らせの領域（role="status"）にする', () => {
    mount();
    expect(strip()).not.toHaveAttribute('role', 'status');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('入力待ち');
    expect(strip().contains(status)).toBe(true);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('入力待ちは、待機の経過と問いを出し、色を tone に出す', () => {
    mount();
    expect(strip()).toHaveAttribute('data-tone', 'wait');
    expect(within(strip()).getByText('4 分待機')).toBeInTheDocument();
    expect(within(strip()).getByText('既存のテストを書き換えてよいですか？')).toBeInTheDocument();
  });

  it('作業中、アイドル、裏だけ動いている、の灯の色を替える', () => {
    const m = mount({ live: 'busy', activity: null });
    expect(strip()).toHaveAttribute('data-tone', 'busy');
    expect(strip().querySelector('.live-dot')).toHaveAttribute('data-tone', 'busy');
    m.rerender({ live: 'idle', activity: null });
    expect(strip()).toHaveAttribute('data-tone', 'idle');
    m.rerender({ live: 'busy', activity: null, aside: { shell: true, agents: 0 } });
    expect(strip()).toHaveAttribute('data-tone', 'aside');
    expect(screen.getByRole('status')).toHaveTextContent('バックグラウンドで作業中');
  });

  it('いまの値：コンテキスト使用量はゲージ（meter）で名前と値を持ち、コスト、ターン、トークンを出す', () => {
    mount();
    const meter = within(strip()).getByRole('meter', { name: 'コンテキスト使用量' });
    expect(meter).toHaveAttribute('aria-valuenow', '41');
    expect(meter).toHaveAttribute('aria-valuetext', '41%');
    expect(within(strip()).getByText('41%')).toBeInTheDocument();
    expect(within(strip()).getByText('$0.86')).toBeInTheDocument();
    expect(within(strip()).getByText('9 ターン')).toBeInTheDocument();
    expect(within(strip()).getByText('31k トークン')).toBeInTheDocument();
  });

  it('コンテキスト使用量が 80% 以上なら、ゲージを警告の色にする', () => {
    mount({ contextPercent: 82 });
    expect(strip().querySelector('.gauge-fill')).toHaveAttribute('data-high', 'true');
  });

  it('値が届いていないときは「未取得」を言う。どちらも無ければ 1 つにまとめる', () => {
    const m = mount({ contextPercent: null });
    expect(within(strip()).getByText('コンテキスト使用量 未取得')).toBeInTheDocument();
    expect(within(strip()).getByText('$0.86')).toBeInTheDocument();
    m.rerender({ contextPercent: null, cost: '' });
    expect(within(strip()).getByText('コンテキスト使用量とコストは未取得')).toBeInTheDocument();
    expect(within(strip()).queryByRole('meter')).toBeNull();
    expect(within(strip()).queryByText('コスト 未取得')).toBeNull();
  });

  it('英語では、辞書の英語の文が出る', () => {
    mount({}, 'en');
    expect(screen.getByRole('region', { name: 'Current state of this session' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Needs input');
    expect(screen.getByRole('meter', { name: 'Context usage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Note' })).toBeInTheDocument();
  });
});

describe('NowStrip の「ノート」の札', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: /^ノート/ }));

  it('ノートが空なら「ノート」、中身があれば「ノート、記入あり」の名前で、印を付ける', () => {
    const m = mount();
    const chip = screen.getByRole('button', { name: 'ノート' });
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    expect(chip).not.toHaveAttribute('data-filled');
    m.rerender({ note: '決済は v3' });
    expect(screen.getByRole('button', { name: 'ノート、記入あり' })).toHaveAttribute('data-filled', 'true');
  });

  it('押すとポップオーバーが開き、そこでノートを読み書きできる。保存で session.setMemo を出す', () => {
    const m = mount({ note: '決済は v3' });
    open();
    const dialog = screen.getByRole('dialog', { name: 'ノート' });
    const area = within(dialog).getByRole('textbox', { name: 'ノート' });
    expect(area).toHaveValue('決済は v3');
    expect(area).toHaveFocus();
    const save = within(dialog).getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.change(area, { target: { value: '決済は v3。テストは checkout/ 以下' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(m.onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '決済は v3。テストは checkout/ 以下' });
    // 保存が通って本文が戻ってきたら、書き換えのない状態に戻る（通らなかったときは、書いたものが残って押せるまま）。
    m.rerender({ note: '決済は v3。テストは checkout/ 以下' });
    expect(save).toBeDisabled();
  });

  it('⌘Enter でも保存できる。日本語入力の変換を確定する Enter では保存しない', () => {
    const m = mount();
    open();
    const area = screen.getByRole('textbox', { name: 'ノート' });
    fireEvent.change(area, { target: { value: '書いた' } });
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true, isComposing: true, keyCode: 229 });
    expect(m.onIntent).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    expect(m.onIntent).toHaveBeenCalledWith({ type: 'session.setMemo', id: 's1', text: '書いた' });
  });

  it('外で書き換えられたとき、書きかけが無ければ追い、あれば黙って捨てずに知らせる', () => {
    const m = mount({ note: 'もと' });
    open();
    const area = screen.getByRole('textbox', { name: 'ノート' });
    act(() => m.rerender({ note: '外で更新' }));
    expect(area).toHaveValue('外で更新');
    fireEvent.change(area, { target: { value: '書きかけ' } });
    act(() => m.rerender({ note: 'さらに外で更新' }));
    expect(area).toHaveValue('書きかけ');
    expect(screen.getByText('ほかで更新されました')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));
    expect(area).toHaveValue('さらに外で更新');
    expect(screen.queryByText('ほかで更新されました')).toBeNull();
  });

  it('Esc で閉じて、焦点は札へ戻る', () => {
    mount();
    open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'ノート' })).toHaveFocus();
  });
});

describe('NowStrip の 2 行目', () => {
  it('今のターンの意図を引用して時刻を添える。無ければ「意図は未記入」', () => {
    const m = mount({ digest: { sessionId: 's1', turnStartSeq: 0, intent: { text: '検証をサーバ側へ寄せる', at: 0, stepsSince: 3, inThisTurn: true }, agents: [] } });
    const intent = within(strip()).getByText('「検証をサーバ側へ寄せる」');
    expect(intent).toHaveAttribute('title', 'Claude が記入、10:01、以降のツール呼び出し 3 回');
    expect(intent).toHaveTextContent('10:01');
    m.rerender({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] } });
    expect(within(strip()).getByText('意図は未記入')).toBeInTheDocument();
  });

  it('30 回を超えた意図は、薄くする印を付ける', () => {
    mount({ digest: { sessionId: 's1', turnStartSeq: 0, intent: { text: 'x', at: 0, stepsSince: 31, inThisTurn: true }, agents: [] } });
    expect(within(strip()).getByText('「x」')).toHaveAttribute('data-stale', 'true');
  });

  it('直近のツール呼び出しを並べ、状態は形と読み上げの語で言う', () => {
    seq = 0;
    const r = call('Read', { file_path: '/w/src/checkout/form.ts' });
    const q = call('AskUserQuestion', { questions: [] });
    mount({ events: [r, res(r), q] });
    const list = within(strip()).getByRole('list', { name: 'ツール呼び出し' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['✓完了 Read form.ts', '●入力待ち AskUserQuestion']);
    expect(items[1]).toHaveAttribute('data-mark', 'wait');
  });

  it('呼び出しが 4 つを超えるときだけ「ほか N」の札を出し、押すと直近 30 回までが開く', () => {
    seq = 0;
    const events: TranscriptEvent[] = [];
    for (let n = 0; n < 6; n++) { const c = call('Read', { file_path: `/w/f${n}.ts` }); events.push(c, res(c)); }
    const m = mount({ events, live: 'idle', activity: null });
    expect(within(strip()).getAllByRole('listitem')).toHaveLength(4);
    const chip = within(strip()).getByRole('button', { name: 'ほか 2' });
    fireEvent.click(chip);
    const dialog = screen.getByRole('dialog', { name: 'ツール呼び出し' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    m.rerender({ events: events.slice(0, 6), live: 'idle', activity: null });
    expect(within(strip()).queryByRole('button', { name: /^ほか/ })).toBeNull();
  });

  it('帯の幅に入り切らない札は、途中で切らず、古い側から丸ごと落として「ほか N」を増やす', () => {
    seq = 0;
    const events: TranscriptEvent[] = [];
    for (let n = 0; n < 4; n++) { const c = call('Read', { file_path: `/w/f${n}.ts` }); events.push(c, res(c)); }
    // 札の幅は 100、「ほか N」も 100、隙間は 12。列が 250 なら、札 1 つと「ほか」が入る（100 + 12 + 100 = 212）。
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    const c = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ns-steps-wrap') ? 250 : 0; });
    try {
      mount({ events, live: 'idle', activity: null });
      const items = within(strip()).getAllByRole('listitem');
      expect(items).toHaveLength(1);
      // 残るのは最後の呼び出し（いまや入力待ちの印を持つ側）。
      expect(items[0]).toHaveTextContent('f3.ts');
      expect(within(strip()).getByRole('button', { name: 'ほか 3' })).toBeInTheDocument();
    } finally { w.mockRestore(); c.mockRestore(); }
  });

  it('サブエージェントの札は、1 本も無ければ出さない。あれば件数の名前で、押すと 1 本ずつの一覧が開く', () => {
    const m = mount();
    expect(within(strip()).queryByRole('button', { name: /^サブエージェント/ })).toBeNull();
    m.rerender({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [agent({ agentId: 'a', title: 'テストの一覧を集める', state: 'done', report: 'checkout/ の 12 件を列挙した' }), agent({ agentId: 'b', title: '型を直す', linked: false })] } });
    const chip = within(strip()).getByRole('button', { name: 'サブエージェント 2' });
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

  it('サブエージェントの行を押すと、その transcript へ切り替える Intent を出して閉じる', () => {
    const m = mount({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [agent({ agentId: 'abc123', title: 'テストの一覧を集める' })] } });
    fireEvent.click(within(strip()).getByRole('button', { name: 'サブエージェント 1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /テストの一覧を集める/ }));
    expect(m.onIntent).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc123' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('アーティファクトの札は、件数の名前で、押すと一覧が開く。題名で開き、鉛筆で VS Code', () => {
    const m = mount({ artifacts: [art('a1'), art('a2', { canOpenEditor: true })] });
    fireEvent.click(within(strip()).getByRole('button', { name: 'アーティファクト 2' }));
    const dialog = screen.getByRole('dialog', { name: 'アーティファクト' });
    expect(within(dialog).getAllByText(/最終公開 12 分前/)).toHaveLength(2);
    expect(within(dialog).getAllByRole('button', { name: /VS Code で開く/ })).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: /成果 a1/ }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'artifact.open', id: 'a1' });
    fireEvent.click(screen.getByRole('button', { name: 'アーティファクト 2' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '成果 a2 を VS Code で開く' }));
    expect(m.onIntent).toHaveBeenLastCalledWith({ type: 'artifact.openEditor', id: 'a2' });
  });

  it('アーティファクトが無ければ札を出さない', () => {
    mount();
    expect(within(strip()).queryByRole('button', { name: /^アーティファクト/ })).toBeNull();
  });
});
