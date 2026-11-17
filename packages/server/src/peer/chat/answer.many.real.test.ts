import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { PaneKey } from '../../tmux/pane.ts';
import { createPeerAnswerer, parseDialog, type AnswerPane } from './answer.ts';
import { REAL_MANY_SUBMIT, REAL_MANY_TAB1, REAL_MANY_TAB2 } from './questionDialogs.real.fixtures.ts';

/** 実機の写しで、問いが複数ある札の読み取りを確かめる（見出しの空白や案内の行が作った見本と違う）。 */
describe('parseDialog: 実機の問いが複数ある札', () => {
  it('1 タブ目', () => {
    const d = parseDialog(REAL_MANY_TAB1)!;
    expect(d.step).toEqual({ index: 1, total: 2, submit: false });
    expect(d.question).toBe('果物はどれ？');
    expect(d.options.map((o) => o.first)).toEqual(['りんご', 'みかん', 'Type something.', 'Chat about this']);
    expect(d.unanswered).toBe(2);
  });
  it('2 タブ目', () => {
    const d = parseDialog(REAL_MANY_TAB2)!;
    expect(d.step).toEqual({ index: 2, total: 2, submit: false });
    expect(d.question).toBe('色はどれ？');
    expect(d.options.map((o) => o.first)).toEqual(['赤', '青', 'Type something.', 'Chat about this']);
    expect(d.unanswered).toBe(1);
  });
  it('確認のタブ（案内の行が無い）', () => {
    const d = parseDialog(REAL_MANY_SUBMIT)!;
    expect(d.step).toEqual({ index: null, total: 2, submit: true });
    expect(d.options.map((o) => o.first)).toEqual(['Submit answers', 'Cancel']);
    expect(d.unanswered).toBe(0);
  });
});

/** 1 問目を飛ばした（☐ のまま）画面。 */
const skip1 = (screen: string): string => screen.replace('☒ 果物', '☐ 果物');

/**
 * 実機の写しで動く、問いが 2 つの札の偽の Claude Code。
 * 番号のキーでそのタブの行を選んで次のタブへ進む。
 * 確認のタブの 1 は送って札を閉じる。
 * noSubmit が真なら、2 問目に答えると札が閉じる（確認のタブが出ない）。
 */
class FakeReal implements AnswerPane {
  events: string[] = [];
  tab: 1 | 2 | 3 | 0 = 1;
  skipped = false;
  noSubmit = false;

  capture(): string {
    if (this.tab === 0) return '● done\n\n❯ \n';
    const s = this.tab === 1 ? REAL_MANY_TAB1 : this.tab === 2 ? REAL_MANY_TAB2 : REAL_MANY_SUBMIT;
    return this.skipped ? skip1(s) : s;
  }

  sendText(text: string): void {
    this.events.push(`text:${text}`);
    if (this.tab === 3) { if (text === '1') this.tab = 0; return; }
    if (text === '1' || text === '2') this.tab = this.tab === 1 ? 2 : this.noSubmit ? 0 : 3;
  }

  sendKey(key: PaneKey): void { this.events.push(`key:${key}`); }
}

const ask = (askId: string, input: string, labels: string[]): PeerChatAsk => ({
  askId, kind: 'question', tool: 'AskUserQuestion', input,
  options: labels.map((label, i) => ({ key: String(i + 1), label })), multi: false, allowText: true,
});
const ASK1 = ask('a1', '果物はどれ？', ['りんご', 'みかん']);
const ASK2 = ask('a2', '色はどれ？', ['赤', '青']);

const rig = () => {
  const pane = new FakeReal();
  return { pane, ...createPeerAnswerer({ pane: () => pane, sleep: async () => {} }) };
};

describe('answerAsk: 実機の写しで、最後の問いの後に確認のタブを送る', () => {
  it('1 問目は次のタブへ進むだけで、2 問目の後に確認のタブで 1 を打つ', async () => {
    const t = rig();
    expect(await t.answerAsk('r1', ASK1, ['1'])).toEqual({ ok: true, label: 'りんご' });
    expect(t.pane.events).toEqual(['text:1']);
    expect(t.pane.tab).toBe(2);
    expect(await t.answerAsk('r1', ASK2, ['2'])).toEqual({ ok: true, label: '青' });
    expect(t.pane.events).toEqual(['text:1', 'text:2', 'text:1']);
    expect(t.pane.tab).toBe(0);
  });

  it('確認のタブに ☐ が残るときは押さない', async () => {
    const t = rig();
    t.pane.tab = 2;
    t.pane.skipped = true;
    expect(await t.answerAsk('r1', ASK2, ['1'])).toEqual({ ok: true, label: '赤' });
    expect(t.pane.events).toEqual(['text:1']);
    expect(t.pane.tab).toBe(3);
  });

  it('確認のタブが出なければ何も打たない', async () => {
    const t = rig();
    t.pane.tab = 2;
    t.pane.noSubmit = true;
    expect(await t.answerAsk('r1', ASK2, ['1'])).toEqual({ ok: true, label: '赤' });
    expect(t.pane.events).toEqual(['text:1']);
    expect(t.pane.tab).toBe(0);
  });
});
