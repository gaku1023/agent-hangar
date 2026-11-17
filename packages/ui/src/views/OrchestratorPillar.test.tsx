import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { OrchestratorPillarProps } from '../presenters/orchestrator.ts';
import { FakeVoicePort } from '../voice/fakeVoicePort.ts';
import { OrchestratorPillar } from './OrchestratorPillar.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import * as kit from './primitives/pillarMotion.ts';

vi.mock('./primitives/motionKit.ts', async (orig) => ({ ...(await orig<typeof import('./primitives/motionKit.ts')>()), fadeIn: vi.fn(() => null), collapseOut: vi.fn(() => Promise.resolve()) }));
import * as motion from './primitives/motionKit.ts';
vi.mock('./primitives/pillarMotion.ts', () => ({ pillarOpen: vi.fn(() => null), pillarClose: vi.fn(() => Promise.resolve()) }));

const base = (o: Partial<OrchestratorPillarProps> = {}): OrchestratorPillarProps => ({
  sessionId: 'o1', tone: 'idle', statusLabel: '待機中', policy: null, approvals: [], rows: [], loading: false, canSend: true, sending: false,
  speak: { reply: null, notices: [], voiceOn: false }, keeper: { stopped: null, switching: false }, context: null, ...o,
});
let port: FakeVoicePort;
let actions: UiAction[];
function mount(p: OrchestratorPillarProps, open = true) {
  const tree = (props: OrchestratorPillarProps) => <LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)}><OrchestratorPillar orch={props} port={port} defaultOpen={open} /></ActionRoot></LanguageRoot>;
  const r = render(tree(p));
  return { ...r, update: (props: OrchestratorPillarProps) => r.rerender(tree(props)) };
}
beforeEach(() => { port = new FakeVoicePort(); actions = []; vi.clearAllMocks(); });
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: '統括のメニュー' }));
function closeByMenu() { openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: /統括を閉じる/ })); }

describe('統括の柱の開き閉じ', () => {
  it('畳んでいるときは丸 1 つで、押すと柱が pillarOpen で開く', () => {
    mount(base(), false);
    expect(screen.queryByRole('region', { name: '統括' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '統括を開く' }));
    expect(screen.getByRole('region', { name: '統括' })).toBeInTheDocument();
    expect(kit.pillarOpen).toHaveBeenCalledWith(expect.any(HTMLElement), expect.any(HTMLElement));
  });
  it('閉じると pillarClose を通ってから外れ、丸に戻る', async () => {
    mount(base());
    closeByMenu();
    expect(kit.pillarClose).toHaveBeenCalledWith(expect.any(HTMLElement), expect.any(HTMLElement));
    await waitFor(() => expect(screen.queryByRole('region', { name: '統括' })).toBeNull());
    expect(screen.getByRole('button', { name: '統括を開く' })).toBeInTheDocument();
  });
  it('閉じる丸の横に ⌘⇧J の札を置き、閉じた丸のホバーにも出す', () => {
    const { container } = mount(base());
    const kbd = container.querySelector('.orch-top kbd');
    expect(kbd?.textContent).toMatch(/⌘⇧J|Ctrl/);
    expect(kbd?.nextElementSibling).toBe(screen.getByRole('button', { name: '統括のメニュー' }));
    cleanup();
    mount(base({ statusLabel: '待機中' }), false);
    expect(screen.getByRole('button', { name: '統括を開く' }).getAttribute('title')).toMatch(/^待機中 .*(⌘⇧J|Ctrl)/);
  });
  it('柱を開いたら、会話の読み込みを頼む', () => {
    mount(base());
    expect(actions).toContainEqual({ type: 'orchestrator.open' });
  });
});

describe('統括の柱の開閉を mediator へ知らせる', () => {
  it('開いたまま始めれば open: true を、閉じれば open: false を出す', () => {
    mount(base());
    expect(actions).toContainEqual({ type: 'orchestrator.pillar', open: true });
    closeByMenu();
    expect(actions).toContainEqual({ type: 'orchestrator.pillar', open: false });
  });
});

describe('統括の柱の中身', () => {
  it('上に方針の 1 行、その下に自動許可の記録を並べ、記録の行を押すとその会話へ移る', () => {
    mount(base({ policy: '読むだけなら通す', approvals: [{ id: 'a1', sessionId: 's9', title: '調べもの', tool: 'Read', head: '/a/b.ts' }] }));
    expect(screen.getByText('読むだけなら通す')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: /調べもの/ });
    expect(row).toHaveTextContent('Read');
    expect(row).toHaveTextContent('/a/b.ts');
    fireEvent.click(row);
    expect(actions).toContainEqual({ type: 'nav.go', to: { name: 'session', id: 's9' } });
  });
  it('方針が無ければ方針の行を出さない', () => {
    const { container } = mount(base());
    expect(container.querySelector('.orch-policy')).toBeNull();
  });
  it('統括が止まっているときは入力欄が送れない', () => {
    mount(base({ canSend: false, tone: 'ended' }));
    expect(screen.getByRole('textbox', { name: '統括へのメッセージ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '送る' })).toBeDisabled();
  });
  it('文を打って送ると orchestrator.send を出し、欄を空にする', () => {
    mount(base());
    const box = screen.getByRole('textbox', { name: '統括へのメッセージ' });
    fireEvent.change(box, { target: { value: '進み具合は' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(actions).toContainEqual({ type: 'orchestrator.send', text: '進み具合は' });
    expect(box).toHaveValue('');
  });
});

describe('統括の柱の音声', () => {
  it('マイクの確定の文は印を付けずに、由来 voice-held で送る。途中の文は入力欄に出る', () => {
    vi.useFakeTimers();
    mount(base());
    fireEvent.click(screen.getByRole('button', { name: '音声で入力' }));
    act(() => port.handlers!.onInterim('進み'));
    expect(screen.getByRole('textbox', { name: '統括へのメッセージ' })).toHaveValue('進み');
    act(() => port.handlers!.onFinal('進み具合は'));
    act(() => { vi.advanceTimersByTime(1300); });
    expect(actions).toContainEqual({ type: 'orchestrator.send', text: '進み具合は', origin: 'voice-held' });
    vi.useRealTimers();
  });
  it('打ちかけの文字は、聞いている間は認識の文の前に残り、送っても捨てても戻る', () => {
    vi.useFakeTimers();
    mount(base());
    const box = screen.getByRole('textbox', { name: '統括へのメッセージ' });
    fireEvent.change(box, { target: { value: '下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '音声で入力' }));
    act(() => port.handlers!.onInterim('進み'));
    expect(box).toHaveValue('下書き 進み');
    act(() => port.handlers!.onFinal('進み具合は'));
    expect(box).toHaveValue('下書き 進み具合は');
    act(() => { vi.advanceTimersByTime(1300); });
    expect(actions).toContainEqual({ type: 'orchestrator.send', text: '進み具合は', origin: 'voice-held' });
    expect(box).toHaveValue('下書き');
    fireEvent.click(screen.getByRole('button', { name: '音声で入力' }));
    act(() => port.handlers!.onInterim('捨てる'));
    expect(box).toHaveValue('下書き 捨てる');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(box).toHaveValue('下書き');
    vi.useRealTimers();
  });
  it('listen が使えない環境ではマイクを出さない', () => {
    port.canListenNow = false;
    mount(base());
    expect(screen.queryByRole('button', { name: '音声で入力' })).toBeNull();
  });
  it('読み上げ中にマイクを押すと cancel が呼ばれて聞き始める', () => {
    mount(base());
    port.isSpeaking = true;
    fireEvent.click(screen.getByRole('button', { name: '音声で入力' }));
    expect(port.calls.slice(0, 2)).toEqual(['cancel', 'listen:ja']);
  });
  it('音声で始まったターンの返答は、待機に戻ってから 1 度だけ読む。柱を開いた時点の返答は読まない', () => {
    const reply = { key: '2', text: '順調です' };
    const { update } = mount(base({ speak: { reply, notices: [], voiceOn: true } }));
    expect(port.calls.filter((c) => c.startsWith('speak'))).toEqual([]);
    const next = { key: '4', text: 'ほぼ終わりです' };
    update(base({ tone: 'busy', speak: { reply: next, notices: [], voiceOn: true } }));
    expect(port.calls.filter((c) => c.startsWith('speak'))).toEqual([]);
    update(base({ tone: 'idle', speak: { reply: next, notices: [], voiceOn: true } }));
    expect(port.calls.filter((c) => c.startsWith('speak'))).toEqual(['speak:ja:ほぼ終わりです']);
    update(base({ tone: 'idle', speak: { reply: next, notices: [], voiceOn: true } }));
    expect(port.calls.filter((c) => c.startsWith('speak'))).toHaveLength(1);
  });
  it('出来事のターンの返答は読まず（reply が無い）、notify_user の文は音声の間だけ読む', () => {
    const { update } = mount(base({ speak: { reply: null, notices: [], voiceOn: true } }));
    update(base({ speak: { reply: null, notices: [{ key: 'n3', text: '判断をお願いします' }], voiceOn: true } }));
    expect(port.calls.filter((c) => c.startsWith('speak'))).toEqual(['speak:ja:判断をお願いします']);
  });
  it('音声を使っていなければ notify_user の文も読まない', () => {
    const { update } = mount(base());
    update(base({ speak: { reply: null, notices: [{ key: 'n3', text: '判断をお願いします' }], voiceOn: false } }));
    expect(port.calls.filter((c) => c.startsWith('speak'))).toEqual([]);
  });
  it('新しい文を送ると読み上げを止める', () => {
    mount(base());
    fireEvent.change(screen.getByRole('textbox', { name: '統括へのメッセージ' }), { target: { value: 'あ' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));
    expect(port.calls).toContain('cancel');
  });
  it('Esc で読み上げを止める', () => {
    mount(base());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(port.calls).toContain('cancel');
  });
});

describe('統括の柱のマイク（補助）', () => {
  const voice = (o: Partial<import('@agent-hangar/shared').VoiceStateDto> = {}): import('@agent-hangar/shared').VoiceStateDto => ({ available: true, models: { state: 'ready', progress: 1 }, mode: 'off', phase: 'ambient', caption: null, speakingId: null, toggled: false, meeting: false, callable: true, ...o });
  it('available が偽なら今の MicButton が出る', () => {
    mount(base({ voice: voice({ available: false }) }));
    expect(screen.getByRole('button', { name: '音声で入力' })).toHaveClass('mic-btn');
  });
  it('voice が無い（読めていない）ときも今の MicButton', () => {
    mount(base());
    expect(screen.getByRole('button', { name: '音声で入力' })).toHaveClass('mic-btn');
  });
  it('available が真なら VoicePill に替わる', () => {
    mount(base({ voice: voice() }));
    const b = screen.getByRole('button', { name: '音声で入力' });
    expect(b).not.toHaveClass('mic-btn');
    expect(b).toHaveAttribute('data-phase', 'ambient');
  });
});

describe('柱のメニュー（右上の丸）', () => {
  it('丸を押すとメニューが開き、頭に状態の行、項目は 会話を新しくする・停止・統括を閉じる', () => {
    mount(base({ statusLabel: 'アイドル' }));
    openMenu();
    const menu = screen.getByRole('menu', { name: '統括のメニュー' });
    expect(menu.querySelector('.menu-head')?.textContent).toContain('アイドル');
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['会話を新しくする', '停止', '統括を閉じる']);
  });
  it('項目を選ぶと orchestrator.control を出す', () => {
    mount(base());
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /会話を新しくする/ }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /停止/ }));
    expect(actions).toContainEqual({ type: 'orchestrator.control', op: 'fresh' });
    expect(actions).toContainEqual({ type: 'orchestrator.control', op: 'stop' });
  });
  it('止まっているときは停止の代わりに再開', () => {
    mount(base({ keeper: { stopped: 'user', switching: false }, tone: 'ended', canSend: false }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /再開/ }));
    expect(actions).toContainEqual({ type: 'orchestrator.control', op: 'wake' });
    expect(screen.queryByRole('menuitem', { name: /停止/ })).toBeNull();
  });
  it('切り替え中は 会話を新しくする と 停止 を押せず、丸が脈打つ', () => {
    const { container } = mount(base({ keeper: { stopped: null, switching: true }, statusLabel: '切り替え中', canSend: false }));
    expect(container.querySelector('.orch-dot-close .orch-dot')?.getAttribute('data-switching')).toBe('true');
    openMenu();
    expect(screen.getByRole('menuitem', { name: /会話を新しくする/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: /停止/ }).getAttribute('aria-disabled')).toBe('true');
    // 理由は頭の段と同じなので、項目の下には出さず title に回す。
    expect(screen.getByRole('menu').querySelectorAll('.menu-item small')).toHaveLength(0);
    expect(screen.getByRole('menuitem', { name: /停止/ }).getAttribute('title')).toBe('切り替え中');
  });
});

describe('柱の上端の文脈の量の棒（案 A2）', () => {
  it('量が分かれば上の帯の下端に棒を出し、幅は割合、札はトークン数', () => {
    const { container } = mount(base({ context: { ratio: 0.4, over: false, label: '文脈: 80k トークン' } }));
    const bar = container.querySelector('.orch-top .orch-context') as HTMLElement;
    expect(bar.getAttribute('aria-label')).toBe('文脈: 80k トークン');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('40%');
    expect(bar.getAttribute('data-over')).toBeNull();
  });
  it('15 万を超えると data-over（作業中の色）', () => {
    const { container } = mount(base({ context: { ratio: 0.8, over: true, label: 'x' } }));
    expect(container.querySelector('.orch-context')?.getAttribute('data-over')).toBe('true');
  });
  it('量が分からなければ棒を出さない', () => {
    const { container } = mount(base());
    expect(container.querySelector('.orch-context')).toBeNull();
  });
});

describe('新しい会話に切り替わったとき', () => {
  const r = (key: string, text: string) => ({ kind: 'assistant' as const, key, text });
  it('前の会話の行を collapseOut で畳み、区切りの線を fadeIn で入れ、その下に新しい会話を積む', async () => {
    const { container, update } = mount(base({ sessionId: 'o1', rows: [r('1', '前の話')] }));
    expect(container.querySelector('.orch-divider')).toBeNull();
    update(base({ sessionId: 'o2', rows: [], loading: true }));
    const old = container.querySelector('.orch-retired');
    expect(old?.textContent).toContain('前の話');
    expect(motion.collapseOut).toHaveBeenCalledWith(old);
    const divider = container.querySelector('.orch-divider') as HTMLElement;
    expect(motion.fadeIn).toHaveBeenCalledWith(divider);
    await waitFor(() => expect(container.querySelector('.orch-retired')).toBeNull());
    update(base({ sessionId: 'o2', rows: [r('9', '引き継ぎを読みました')] }));
    expect(divider.nextElementSibling?.textContent).toContain('引き継ぎを読みました');
  });
});
