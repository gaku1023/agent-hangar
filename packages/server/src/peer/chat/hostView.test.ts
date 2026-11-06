import { describe, expect, it } from 'vitest';
import { pendingAskFrom } from './hostView.ts';
import type { HostSession } from './hostTypes.ts';

const session = (over: Partial<HostSession> = {}): HostSession => ({ provider: 'claude-code', live: 'waiting', waitingFor: 'permission', permission: null, activity: null, cwd: '/p', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false, ...over });
const RULE = '╌'.repeat(44);

describe('pendingAskFrom', () => {
  const perm = [' Bash command', ' mock desc', RULE, ' ls -la', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n');

  it('許可は、画面の行の文を label にし、番号を key にする', () => {
    const a = pendingAskFrom(session({ permission: { tool: 'Bash', input: 'ls -la', description: 'd' } }), perm)!;
    expect(a).toMatchObject({ kind: 'permission', tool: 'Bash', input: 'ls -la', multi: false, allowText: false });
    expect(a.options).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
  });

  it('登録に許可の中身が無ければ、罫線に挟まれた文字を input にして道具は付けない', () => {
    const a = pendingAskFrom(session(), perm)!;
    expect(a.tool).toBeUndefined();
    expect(a.input).toBe('ls -la');
  });

  it('画面に札が無ければ null', () => {
    expect(pendingAskFrom(session(), '● done\n\n❯ \n')).toBeNull();
  });

  it('質問は問いの文を input にし、Type something は自由入力、Chat about this は選択肢に出さない', () => {
    const screen = [' ☐ Choice', 'Which one?', '❯ 1. Alpha', '     Alpha (description)', '  2. Beta', '     Beta (description)', '  3. Type something.', '──────────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    const a = pendingAskFrom(session({ waitingFor: 'question', activity: { tool: 'AskUserQuestion', summary: '', question: 'Which one?' } }), screen)!;
    expect(a).toMatchObject({ kind: 'question', tool: 'AskUserQuestion', input: 'Which one?', multi: false, allowText: true });
    expect(a.options.map((o) => o.label)).toEqual(['Alpha', 'Beta']);
  });
});
