import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { hookChoiceOf } from './hookAnswer.ts';

const perm = (): PeerChatAsk => ({ askId: 'a', kind: 'permission', tool: 'Bash', input: 'x', options: [], multi: false, allowText: false });
const q = (over: Partial<PeerChatAsk> = {}): PeerChatAsk => ({ askId: 'q', kind: 'question', tool: 'AskUserQuestion', input: 'Which?', options: [], multi: false, allowText: true, ...over });

describe('hookChoiceOf', () => {
  it('許可は Yes だけ allow、No と No, and tell… は deny', () => {
    expect(hookChoiceOf(perm(), ['Yes'], undefined)).toEqual({ kind: 'permission', behavior: 'allow' });
    expect(hookChoiceOf(perm(), ['No'], undefined)).toEqual({ kind: 'permission', behavior: 'deny' });
    expect(hookChoiceOf(perm(), ['No, and tell Claude what to do differently'], undefined)).toEqual({ kind: 'permission', behavior: 'deny' });
  });

  it('いつも許可と、モードを替える行は hook で言えないので null（画面で打つ）', () => {
    expect(hookChoiceOf(perm(), ["Yes, and don't ask again for npm commands in /w"], undefined)).toBeNull();
    expect(hookChoiceOf(perm(), ['Yes, allow all edits during this session (shift+tab)'], undefined)).toBeNull();
    expect(hookChoiceOf(perm(), ['Yes, and switch to auto mode'], undefined)).toBeNull();
  });

  it('質問は、選んだラベルか自由な文。複数選択は ", " でつなぐ', () => {
    expect(hookChoiceOf(q(), ['Red'], undefined)).toEqual({ kind: 'question', value: 'Red' });
    expect(hookChoiceOf(q(), [], 'my own')).toEqual({ kind: 'question', value: 'my own' });
    expect(hookChoiceOf(q({ multi: true }), ['Apple', 'Fig'], undefined)).toEqual({ kind: 'question', value: 'Apple, Fig' });
    expect(hookChoiceOf(q({ multi: true }), ['Apple'], 'kiwi')).toEqual({ kind: 'question', value: 'Apple, kiwi' });
  });

  it('問いが複数ある札のタブ（step）と、答えが空のときは null', () => {
    expect(hookChoiceOf(q({ step: { index: 1, total: 2 } }), ['Red'], undefined)).toBeNull();
    expect(hookChoiceOf(q(), [], undefined)).toBeNull();
  });
});
