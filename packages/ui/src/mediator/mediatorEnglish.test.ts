import { describe, expect, it } from 'vitest';
import type { SettingsDto } from '@agent-hangar/shared';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';
import { initialStore, type Store } from '../store/store.ts';

/** 言語を英語にしたとき、Mediator が出す知らせとダイアログの文言が英語になる。日本語の文が混ざらないことも見る。 */
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const en: Store = { ...initialStore(), settings: { language: 'en' } as SettingsDto };
const intent = (i: Extract<Input, { kind: 'intent' }>['intent']): Input => ({ kind: 'intent', intent: i });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });
const step = (state: State, input: Input) => transition(state, en, input);
const messages = (effects: unknown[]) => (effects as { kind: string; message?: string }[]).filter((e) => e.kind === 'toast').map((e) => e.message);

describe('Mediator の文（英語）', () => {
  it('切れたあとに戻ったら、追いついたことを知らせる', () => {
    const closed = step(initialState(), runtime({ type: 'ws.close', at: 1 })).state;
    expect(messages(step(closed, runtime({ type: 'ws.open' })).effects)).toEqual(['Caught up with the latest state']);
  });
  it('プロジェクトを選ばずに起動を押したら、選ぶよう言う', () => {
    const r = step(initialState(), intent({ type: 'session.new.submit', params: {} }));
    expect(r.state.launch).toEqual({ kind: 'failed', message: 'Select a project' });
  });
  it('hangar に移動するあいだ、先に一言出す', () => {
    const r = step(initialState(), intent({ type: 'session.adopt', id: 's1', confirmed: true }));
    expect(messages(r.effects)).toEqual(['Moving to Hangar']);
  });
  it('昇格：名前の検査と、ダイアログを閉じたあとの知らせ', () => {
    const open = step(initialState(), intent({ type: 'session.promote.open', id: 's1' })).state;
    expect(step(open, intent({ type: 'session.promote.submit', id: 's1', name: ' ', gitInit: false, moveFiles: false })).state.promote).toEqual({ kind: 'failed', message: 'Enter a name' });
    expect(step(open, intent({ type: 'session.promote.submit', id: 's1', name: 'a/b', gitInit: false, moveFiles: false })).state.promote).toEqual({ kind: 'failed', message: 'The name cannot contain /' });
    expect(messages(step(initialState(), runtime({ type: 'promote.done', projectId: 'p1', moved: false, reason: null })).effects)).toEqual(['Promoted to project']);
  });
  it('作成：ダイアログを閉じたあとの知らせ', () => {
    expect(messages(step(initialState(), runtime({ type: 'project.create.done', projectId: 'p1', startSession: false })).effects)).toEqual(['Project created']);
  });
  it('入力待ちが無いときの知らせ', () => {
    expect(messages(step(initialState(), intent({ type: 'session.nextWaiting' })).effects)).toEqual(['No sessions need input']);
  });
  it('iTerm2 を選んだときの案内', () => {
    const r = step(initialState(), intent({ type: 'settings.update', patch: { terminalApp: 'iterm' } }));
    const [text] = messages(r.effects);
    expect(text).toBe('The first time you open in iTerm2, macOS shows an automation permission dialog');
    expect(text).not.toMatch(JAPANESE);
  });
});
