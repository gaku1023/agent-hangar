import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { OrchestratorPillarProps } from '../presenters/orchestrator.ts';
import { FakeVoicePort } from '../voice/fakeVoicePort.ts';
import { OrchestratorPillar } from './OrchestratorPillar.tsx';
import { LanguageRoot } from './primitives/language.tsx';
import * as kit from './primitives/motionKit.ts';

vi.mock('./primitives/motionKit.ts', async (orig) => ({ ...(await orig<typeof import('./primitives/motionKit.ts')>()), growIn: vi.fn(() => null), collapseOut: vi.fn(() => Promise.resolve()), fadeIn: vi.fn(() => null) }));

const base = (o: Partial<OrchestratorPillarProps> = {}): OrchestratorPillarProps => ({
  sessionId: 'o1', tone: 'idle', statusLabel: '待機中', policy: null, approvals: [], rows: [], loading: false, canSend: true, sending: false,
  speak: { reply: null, notices: [], voiceOn: false }, ...o,
});
let port: FakeVoicePort;
let actions: UiAction[];
function mount(p: OrchestratorPillarProps, open = true) {
  const tree = (props: OrchestratorPillarProps) => <LanguageRoot language="ja"><ActionRoot onAction={(a) => actions.push(a)}><OrchestratorPillar orch={props} port={port} defaultOpen={open} /></ActionRoot></LanguageRoot>;
  const r = render(tree(p));
  return { ...r, update: (props: OrchestratorPillarProps) => r.rerender(tree(props)) };
}
beforeEach(() => { port = new FakeVoicePort(); actions = []; vi.clearAllMocks(); });

describe('統括の柱の開き閉じ', () => {
  it('畳んでいるときは丸 1 つで、押すと柱が growIn で開く', () => {
    mount(base(), false);
    expect(screen.queryByRole('region', { name: '統括' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '統括を開く' }));
    expect(screen.getByRole('region', { name: '統括' })).toBeInTheDocument();
    expect(kit.growIn).toHaveBeenCalledWith(expect.any(HTMLElement), 'x');
  });
  it('閉じると collapseOut を通ってから外れ、丸に戻る', async () => {
    mount(base());
    fireEvent.click(screen.getByRole('button', { name: '統括を閉じる' }));
    expect(kit.collapseOut).toHaveBeenCalledWith(expect.any(HTMLElement), 'x');
    await waitFor(() => expect(screen.queryByRole('region', { name: '統括' })).toBeNull());
    expect(screen.getByRole('button', { name: '統括を開く' })).toBeInTheDocument();
  });
  it('柱を開いたら、会話の読み込みを頼む', () => {
    mount(base());
    expect(actions).toContainEqual({ type: 'orchestrator.open' });
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
  it('マイクの確定の文は [voice] を付けて送る。途中の文は入力欄に出る', () => {
    vi.useFakeTimers();
    mount(base());
    fireEvent.click(screen.getByRole('button', { name: '音声で入力' }));
    act(() => port.handlers!.onInterim('進み'));
    expect(screen.getByRole('textbox', { name: '統括へのメッセージ' })).toHaveValue('進み');
    act(() => port.handlers!.onFinal('進み具合は'));
    act(() => { vi.advanceTimersByTime(1300); });
    expect(actions).toContainEqual({ type: 'orchestrator.send', text: '[voice] 進み具合は' });
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
