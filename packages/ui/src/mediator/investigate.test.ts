import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { codexAccountsFixture } from '../test/accounts.ts';
import { initialStore, type Store } from '../store/store.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

const action = (i: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: i });
const runtime = (event: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event });

const store: Store = { ...initialStore(), version: '0.13.1', accounts: codexAccountsFixture, sessions: { s1: { id: 's1', provider: 'claude-code' } as SessionDto } };
const base = (): State => ({ ...initialState(), screen: { name: 'home', q: '' } }) as State;
const investigate = { type: 'investigate.open' as const, op: 'sync' as const, message: '401 Unauthorized' };

describe('エージェントで調査…', () => {
  it('クイックセッションのダイアログを、依頼の文とエラーの引用とアカウントを埋めて開く', () => {
    const r = transition(base(), store, action(investigate));
    expect(r.state.overlay).toMatchObject({ kind: 'newSession', projectId: null, scratch: true });
    const o = r.state.overlay as Extract<State['overlay'], { kind: 'newSession' }>;
    expect(o.seed?.request).toContain('draft_issue_report');
    expect(o.seed?.quote).toContain('エラー：401 Unauthorized');
    expect(o.seed?.accounts).toEqual({ 'claude-code': 'primary', codex: 'primary' });
  });

  it('修復のダイアログから押すと、修復を閉じて新しいセッションのダイアログにする', () => {
    const repair = transition(base(), store, action({ type: 'linkRepair.open', agent: 'claude-code', accountId: 'a1' })).state;
    const r = transition(repair, store, action({ type: 'investigate.open', op: 'linkRepair', message: 'x', agent: 'claude-code', accountId: 'a1' }));
    expect(r.state.overlay).toMatchObject({ kind: 'newSession', scratch: true });
    expect(r.state.linkRepair).toEqual({ detail: null, working: false, error: null });
  });

  it('起動に失敗した新しいセッションのダイアログから押すと、そのダイアログを埋め直す', () => {
    const ns = transition(base(), store, action({ type: 'session.new.open', projectId: 'p1' })).state;
    const failed = transition(ns, store, runtime({ type: 'launch.failed', message: 'spawn codex ENOENT' })).state;
    const r = transition(failed, store, action({ type: 'investigate.open', op: 'launch', message: 'spawn codex ENOENT' }));
    expect(r.state.overlay).toMatchObject({ kind: 'newSession', projectId: null, scratch: true });
    expect(r.state.launch).toEqual({ kind: 'idle' });
  });

  it('アカウントを足すダイアログの失敗の行から押すと、そのダイアログを閉じて差し替える', () => {
    const add: State = { ...base(), overlay: { kind: 'addAccount' }, accountAdd: { kind: 'failed', message: 'x' } as State['accountAdd'] };
    const r = transition(add, store, action({ type: 'investigate.open', op: 'accountAdd', message: 'x', agent: 'claude-code' }));
    expect(r.state.overlay).toMatchObject({ kind: 'newSession', scratch: true });
    expect(r.state.accountAdd).toEqual({ kind: 'idle' });
  });
  it('確認のダイアログが出ていれば、差し替えない', () => {
    const s: State = { ...base(), overlay: { kind: 'confirm', confirm: { kind: 'adoptSession', sessionId: 's1' } } };
    expect(transition(s, store, action(investigate)).state.overlay).toEqual(s.overlay);
  });

  it('埋めて開いたダイアログから起動し終えても、前からの下書きは消さない', () => {
    const draft = { name: '', prompt: '書きかけ', attachments: [] };
    const opened = transition({ ...base(), newSessionDraft: draft }, store, action(investigate)).state;
    const sent = transition(opened, store, action({ type: 'session.new.submit', params: { scratch: true, prompt: 'p' } })).state;
    const done = transition(sent, store, runtime({ type: 'launch.done', sessionId: 's2', runId: 'r2' }));
    expect(done.state.newSessionDraft).toEqual(draft);
    expect(done.effects.some((e) => e.kind === 'storage.save')).toBe(false);
  });

  it('送った後に閉じてから起動し終えても、下書きは消さない', () => {
    const draft = { name: '', prompt: '書きかけ', attachments: [] };
    const opened = transition({ ...base(), newSessionDraft: draft }, store, action(investigate)).state;
    const sent = transition(opened, store, action({ type: 'session.new.submit', params: { scratch: true, prompt: 'p' } })).state;
    const closed = transition(sent, store, action({ type: 'overlay.close' })).state;
    expect(transition(closed, store, runtime({ type: 'launch.done', sessionId: 's2', runId: 'r2' })).state.newSessionDraft).toEqual(draft);
  });

  it('ふつうに開いたダイアログから起動し終えたら、今までどおり下書きを消す', () => {
    const opened = transition({ ...base(), newSessionDraft: { name: '', prompt: '書きかけ', attachments: [] } }, store, action({ type: 'session.new.open' })).state;
    const sent = transition(opened, store, action({ type: 'session.new.submit', params: { scratch: true, prompt: 'p' } })).state;
    expect(transition(sent, store, runtime({ type: 'launch.done', sessionId: 's2', runId: 'r2' })).state.newSessionDraft).toBeNull();
  });
});

describe('失敗のトーストに「エージェントで調査…」', () => {
  const toastSend = (s: State) => s.toasts.at(-1)?.action;
  it('再開の失敗は、元のセッションを添える', () => {
    const sent = transition(base(), store, action({ type: 'session.resume', id: 's1' })).state;
    const r = transition(sent, store, runtime({ type: 'launch.failed', message: '再開できませんでした' }));
    expect(r.state.toasts.at(-1)?.message).toBe('再開できませんでした');
    expect(toastSend(r.state)).toEqual({ label: 'エージェントで調査…', title: 'エラーの内容を入れた新しいセッションのダイアログを開きます。', send: { type: 'investigate.open', op: 'resume', message: '再開できませんでした', sessionId: 's1' } });
  });
  it('フォークの失敗', () => {
    const sent = transition(base(), store, action({ type: 'session.fork', id: 's1' })).state;
    expect(toastSend(transition(sent, store, runtime({ type: 'launch.failed', message: 'x' })).state)?.send).toEqual({ type: 'investigate.open', op: 'fork', message: 'x', sessionId: 's1' });
  });
  it('ダイアログを閉じた後の起動の失敗は、送ったエージェントとアカウントを添える', () => {
    const opened = transition(base(), store, action({ type: 'session.new.open' })).state;
    const sent = transition(opened, store, action({ type: 'session.new.submit', params: { scratch: true, agent: 'codex', account: 'cw' } })).state;
    const closed = transition(sent, store, action({ type: 'overlay.close' })).state;
    expect(toastSend(transition(closed, store, runtime({ type: 'launch.failed', message: 'x' })).state)?.send).toEqual({ type: 'investigate.open', op: 'launch', message: 'x', agent: 'codex', accountId: 'cw' });
  });
  it('修復の効く失敗は、「修復…」だけ', () => {
    const r = transition(base(), store, runtime({ type: 'launch.failed', message: 'x', linkConflict: { agent: 'claude-code', accountId: 'a1' } }));
    expect(toastSend(r.state)?.send.type).toBe('linkRepair.open');
  });
  it('アカウントの切り替えの失敗（api.failed に事情が付いたもの）', () => {
    const r = transition(base(), store, runtime({ type: 'api.failed', message: 'x', investigate: { op: 'accountSwitch', message: 'x', accountId: 'a1', agent: 'claude-code' } }));
    expect(r.state.toasts.at(-1)).toMatchObject({ level: 'error', message: 'x', action: { label: 'エージェントで調査…', send: { type: 'investigate.open', op: 'accountSwitch', message: 'x', accountId: 'a1', agent: 'claude-code' } } });
  });
});
