import { describe, expect, it } from 'vitest';
import { pendingAskFromHook } from './hookCard.ts';

const uq = (questions: unknown) => ({ providerSessionId: 'u1', tool: 'AskUserQuestion', input: '', toolInput: { questions }, suggestions: [] as unknown[] });

describe('pendingAskFromHook', () => {
  it('許可は、道具と主な引数と、Yes・No の 2 行の札にする（いつも許可は出さない）', () => {
    const a = pendingAskFromHook({ providerSessionId: 'u1', tool: 'Write', input: '/w/a.txt', toolInput: { file_path: '/w/a.txt' }, suggestions: [{ type: 'addRules' }] }, 'write a file');
    expect(a).toEqual({ kind: 'permission', tool: 'Write', input: '/w/a.txt', description: 'write a file', options: [{ key: 'allow', label: 'Yes' }, { key: 'deny', label: 'No' }], multi: false, allowText: false });
  });

  it('質問は、問いの文と選択肢のラベル。自由な文も受ける。複数選択は multi', () => {
    const q = [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }];
    expect(pendingAskFromHook(uq(q), null)).toEqual({ kind: 'question', tool: 'AskUserQuestion', input: 'Which?', question: 'Which?', options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }], multi: true, allowText: true });
  });

  it('問いが 2 つ以上の質問と、形の違う入力は札にしない（画面の札だけにする）', () => {
    expect(pendingAskFromHook(uq([{ question: 'a', options: [{ label: 'x' }] }, { question: 'b', options: [{ label: 'y' }] }]), null)).toBeNull();
    expect(pendingAskFromHook(uq([{ question: 'a' }]), null)).toBeNull();
    expect(pendingAskFromHook(uq('x'), null)).toBeNull();
  });

  it('許可で主な引数が読めない道具（input が空）は札にしない（どの札とも照合できない）', () => {
    expect(pendingAskFromHook({ providerSessionId: 'u1', tool: 'Weird', input: '', toolInput: {}, suggestions: [] }, null)).toBeNull();
  });
});
