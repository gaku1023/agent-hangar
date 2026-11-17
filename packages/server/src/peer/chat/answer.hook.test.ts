import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { HookChoice } from '../../sessions/hookDecisions.ts';
import { createPeerAnswerer, type AnswerPane } from './answer.ts';

/**
 * hook の待ちがあれば、画面にキーを打たずに hook で答える（answer.ts の deps.hook）。
 * 言えない答え（いつも許可、複数の問いのタブ）と、台本が受け取らないときは、今までどおりキーを打つ。
 */
const RULE = '╌'.repeat(44);
class Pane implements AnswerPane {
  keys: string[] = [];
  open = true;
  constructor(private readonly kind: 'permission' | 'question' | 'tabs') {}
  capture(): string {
    if (!this.open) return '● done\n\n❯ \n';
    if (this.kind === 'permission') {
      return [' Bash command', ' desc', RULE, ' echo hi', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for echo commands in /w", '   3. No', ' Esc to cancel · Tab to amend'].join('\n') + '\n';
    }
    const chips = this.kind === 'tabs' ? [' ← ☐ Color  ☐ Size  ✔ Submit →'] : [' ☐ Color'];
    return [...chips, 'Which color?', '❯ 1. Red', '     Red (description)', '  2. Blue', '     Blue (description)', '  3. Type something.', '──────────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n') + '\n';
  }
  sendKey(key: string): void { this.keys.push(`key:${key}`); }
  sendText(text: string): void { this.keys.push(`text:${text}`); }
}
const perm: PeerChatAsk = { askId: 'a1', kind: 'permission', tool: 'Bash', input: 'echo hi', options: [{ key: '1', label: 'Yes' }, { key: '2', label: "Yes, and don't ask again for echo commands in /w" }, { key: '3', label: 'No' }], multi: false, allowText: false };
const quest: PeerChatAsk = { askId: 'q1', kind: 'question', tool: 'AskUserQuestion', input: 'Which color?', options: [{ key: '1', label: 'Red' }, { key: '2', label: 'Blue' }], multi: false, allowText: true };

function setup(pane: Pane, hook: { decide: (c: HookChoice) => boolean; delivered?: boolean; closeOnDecide?: boolean }) {
  const decided: HookChoice[] = [];
  const withdrawn: string[] = [];
  const a = createPeerAnswerer({
    pane: (id) => (id === 'r1' ? pane : null),
    sleep: async () => {},
    hook: {
      decide: (_run, _ask, c) => {
        decided.push(c);
        if (!hook.decide(c)) return null;
        if (hook.closeOnDecide !== false) pane.open = false;
        return { id: 'h1' };
      },
      delivered: () => hook.delivered !== false,
      withdraw: (id) => { withdrawn.push(id); },
    },
  });
  return { ...a, decided, withdrawn };
}

describe('answerAsk: hook で答える', () => {
  it('許可の Yes は、キーを打たずに hook の allow で答える', async () => {
    const pane = new Pane('permission');
    const t = setup(pane, { decide: () => true });
    expect(await t.answerAsk('r1', perm, ['1'])).toEqual({ ok: true, label: 'Yes' });
    expect(t.decided).toEqual([{ kind: 'permission', behavior: 'allow' }]);
    expect(pane.keys).toEqual([]);
  });

  it('許可の No は deny、質問は選んだラベルと自由な文を value にする', async () => {
    const p1 = new Pane('permission');
    expect(await setup(p1, { decide: () => true }).answerAsk('r1', perm, ['3'])).toEqual({ ok: true, label: 'No' });
    const p2 = new Pane('question');
    const t2 = setup(p2, { decide: () => true });
    expect(await t2.answerAsk('r1', quest, ['2'])).toEqual({ ok: true, label: 'Blue' });
    expect(t2.decided).toEqual([{ kind: 'question', value: 'Blue' }]);
    const p3 = new Pane('question');
    const t3 = setup(p3, { decide: () => true });
    expect(await t3.answerAsk('r1', quest, [], 'something else')).toEqual({ ok: true, label: 'something else' });
    expect(t3.decided).toEqual([{ kind: 'question', value: 'something else' }]);
    expect([p1.keys, p2.keys, p3.keys]).toEqual([[], [], []]);
  });

  it('いつも許可の行は hook で言えないので、hook に頼まず、キーを打つ', async () => {
    const pane = new Pane('permission');
    const t = setup(pane, { decide: () => true });
    await t.answerAsk('r1', perm, ['2']);
    expect(t.decided).toEqual([]);
    expect(pane.keys).toEqual(['text:2']);
  });

  it('問いが複数ある札のタブは、hook に頼まず、キーを打つ', async () => {
    const pane = new Pane('tabs');
    const t = setup(pane, { decide: () => true });
    await t.answerAsk('r1', { ...quest, step: { index: 1, total: 2 } }, ['1']);
    expect(t.decided).toEqual([]);
    expect(pane.keys[0]).toBe('text:1');
  });

  it('待ちが無い（hook が合わない）ときは、キーを打つ', async () => {
    const pane = new Pane('permission');
    const t = setup(pane, { decide: () => false });
    await t.answerAsk('r1', perm, ['1']);
    expect(pane.keys).toEqual(['text:1']);
  });

  it('台本が答えを受け取らず札も閉じないときは、取り下げてキーを打つ', async () => {
    const pane = new Pane('permission');
    const t = setup(pane, { decide: () => true, delivered: false, closeOnDecide: false });
    await t.answerAsk('r1', perm, ['1']);
    expect(t.withdrawn).toEqual(['h1']);
    expect(pane.keys).toEqual(['text:1']);
  });

  it('台本は受け取ったのに札が閉じないときは、sent 付きで断る（キーは打たない）', async () => {
    const pane = new Pane('permission');
    const t = setup(pane, { decide: () => true, closeOnDecide: false });
    expect(await t.answerAsk('r1', perm, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch', sent: true });
    expect(pane.keys).toEqual([]);
  });

  it('画面の札が頼みと違えば、hook に頼まずに断る', async () => {
    const pane = new Pane('permission');
    const t = setup(pane, { decide: () => true });
    expect(await t.answerAsk('r1', { ...perm, input: 'rm -rf /' }, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(t.decided).toEqual([]);
  });
});
