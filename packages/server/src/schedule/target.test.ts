import { describe, expect, it } from 'vitest';
import { MessageError } from '../i18n/message.ts';
import { parseNewTarget } from './target.ts';

const on = () => true;
const keyOf = (f: () => unknown): string | undefined => {
  try { f(); } catch (e) { return e instanceof MessageError ? e.text?.key : `other:${String(e)}`; }
  return undefined;
};

describe('parseNewTarget', () => {
  it('古い形はそのままの形で返る（余計なキーが増えない）', () => {
    expect(parseNewTarget({ kind: 'new', projectId: 'p1' }, on)).toStrictEqual({ kind: 'new', projectId: 'p1' });
    expect(parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'opencode' }, on)).toStrictEqual({ kind: 'new', projectId: 'p1', agent: 'opencode' });
  });

  it('空の項目は保存しない', () => {
    expect(parseNewTarget({ kind: 'new', projectId: 'p1', model: '', name: '  ', addDirs: ['', ' '], autoApprove: false, scratch: false }, on)).toStrictEqual({ kind: 'new', projectId: 'p1' });
  });

  it('Claude Code の全項目を保つ', () => {
    const t = { kind: 'new', projectId: 'p1', agent: 'claude-code', name: 'n', account: 'a1', model: 'sonnet', effort: 'high', permissionMode: 'acceptEdits', worktree: 'w', addDirs: ['/x'], cwd: 'sub' } as const;
    expect(parseNewTarget(t, on)).toStrictEqual(t);
  });

  it('Codex の worktree と addDirs と mode と autoApprove は、既存の文で断る。account は通る', () => {
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex', worktree: 'w' }, on))).toBe('run.agent.codex.optionUnsupported');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex', addDirs: ['/x'] }, on))).toBe('run.agent.codex.optionUnsupported');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex', mode: 'plan' }, on))).toBe('run.agent.codex.optionUnsupported');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex', autoApprove: true }, on))).toBe('run.agent.codex.optionUnsupported');
    expect(parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex', account: 'c1', model: 'gpt-5', effort: 'high', permissionMode: 'full-access' }, on))
      .toMatchObject({ agent: 'codex', account: 'c1', permissionMode: 'full-access' });
  });

  it('opencode の account、effort、permissionMode、worktree、addDirs は断り、mode、model、autoApprove は通る', () => {
    for (const o of [{ account: 'a' }, { effort: 'high' }, { permissionMode: 'plan' }, { worktree: 'w' }, { addDirs: ['/x'] }]) {
      expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'opencode', ...o }, on))).toBe('run.agent.optionUnsupported');
    }
    expect(parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'opencode', mode: 'plan', model: 'lmstudio/x', autoApprove: true }, on))
      .toStrictEqual({ kind: 'new', projectId: 'p1', agent: 'opencode', mode: 'plan', model: 'lmstudio/x', autoApprove: true });
  });

  it('Claude Code に mode と autoApprove は断る（既定の agent も同じ）', () => {
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', mode: 'plan' }, on))).toBe('schedules.error.optionNotForClaude');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'claude-code', autoApprove: true }, on))).toBe('schedules.error.optionNotForClaude');
  });

  it('クイックセッションは projectId が null で scratch が要る。矛盾は断る', () => {
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: null }, on))).toBe('schedules.error.target');
    expect(parseNewTarget({ kind: 'new', projectId: null, scratch: true }, on)).toStrictEqual({ kind: 'new', projectId: null, scratch: true });
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', scratch: true }, on))).toBe('schedules.error.target');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: null, scratch: true, cwd: 'sub' }, on))).toBe('schedules.error.target');
  });

  it('形の誤りは断る', () => {
    expect(keyOf(() => parseNewTarget(null, on))).toBe('schedules.error.target');
    expect(keyOf(() => parseNewTarget({ kind: 'session', sessionId: 's' }, on))).toBe('schedules.error.target');
    expect(keyOf(() => parseNewTarget({ kind: 'new' }, on))).toBe('schedules.error.target');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', model: 3 }, on))).toBe('schedules.error.target');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', addDirs: 'x' }, on))).toBe('schedules.error.target');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', autoApprove: 'yes' }, on))).toBe('schedules.error.target');
  });

  it('知らない agent と、有効でない agent は断る', () => {
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'nope' }, on))).toBe('run.agent.unknown');
    expect(keyOf(() => parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'codex' }, (a) => a === 'claude-code'))).toBe('run.agent.disabled');
    expect(parseNewTarget({ kind: 'new', projectId: 'p1', agent: 'claude-code' }, () => false)).toMatchObject({ agent: 'claude-code' });
  });
});
