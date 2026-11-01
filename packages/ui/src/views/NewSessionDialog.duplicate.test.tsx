import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewSessionSeed, UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

// 「同じ設定で新しいセッション…」で開いたダイアログ。入れた値がそのまま送られ、本文は空で、押すまで起動しない。

const base: NewSessionProps = { projects: [{ id: 'p1', name: 'app', path: '/w/app', status: 'active', lastActivity: '' }], recentIds: [], projectId: 'p1', submitting: false, error: null, scratch: false, draft: null, prefs: { p1: { model: 'haiku' } }, dirs: [], takenNames: [], workspaceRoot: '/w', desktop: false, picked: null, createdProjectId: null, accounts: null } as unknown as NewSessionProps;
const seedOf = (settings: NonNullable<NewSessionSeed['settings']>): NewSessionSeed => ({ request: '', quote: '', accounts: {}, settings });
const none = { model: null, effort: null, permissionMode: null, mode: null, addDirs: [] };

const mount = (over: Partial<NewSessionProps>) => {
  const out: UiAction[] = [];
  render(<ActionRoot onAction={(i) => { out.push(i); }}><NewSessionDialog {...base} {...over} /></ActionRoot>);
  return out;
};
const start = () => fireEvent.click(screen.getByRole('button', { name: /^(Bypass permissions で)?起動$/ }));
const sent = (out: UiAction[]) => (out.find((a) => a.type === 'session.new.submit') as Extract<UiAction, { type: 'session.new.submit' }> | undefined)?.params;

afterEach(cleanup);

describe('NewSessionDialog の設定を入れた種', () => {
  it('Claude Code：前回値でなく入れた値を送る。本文は空で、開いただけでは送らない', () => {
    const out = mount({ seed: seedOf({ ...none, agent: 'claude-code', model: 'opus', effort: 'high', permissionMode: 'plan', addDirs: ['/x'] }) });
    expect(sent(out)).toBeUndefined();
    start();
    const p = sent(out);
    expect(p).toMatchObject({ projectId: 'p1', model: 'opus', effort: 'high', permissionMode: 'plan', addDirs: ['/x'] });
    expect(p?.prompt).toBeUndefined();
    expect(p?.worktree).toBeUndefined();
  });
  it('引用の箱を出さない', () => {
    mount({ seed: seedOf({ ...none, agent: 'claude-code' }) });
    expect(document.querySelector('.pc-quote')).toBeNull();
  });
  it('Codex：モデル、推論、権限を入れる。full-access は引き継がず、自動から始める', () => {
    const cx = { codex: { options: null } };
    const a = mount({ ...cx, seed: seedOf({ ...none, agent: 'codex', model: 'gpt-x', effort: 'high', permissionMode: 'read-only' }) });
    start();
    expect(sent(a)).toMatchObject({ agent: 'codex', model: 'gpt-x', permissionMode: 'read-only' });
    cleanup();
    const b = mount({ ...cx, seed: seedOf({ ...none, agent: 'codex', permissionMode: 'full-access' }) });
    start();
    expect(sent(b)).toMatchObject({ agent: 'codex', permissionMode: 'auto' });
  });
  it('opencode：モードとモデルを入れる。自動承認はオフから始める', () => {
    const out = mount({ opencode: { options: null }, seed: seedOf({ ...none, agent: 'opencode', model: 'lmstudio/q', mode: 'plan' }) });
    start();
    expect(sent(out)).toMatchObject({ agent: 'opencode', model: 'lmstudio/q', mode: 'plan', autoApprove: false });
  });
  it('有効でないエージェントの種は Claude Code で開く', () => {
    const out = mount({ seed: seedOf({ ...none, agent: 'codex', model: 'gpt-x' }) });
    start();
    expect(sent(out)?.agent).toBeUndefined();
  });
});
