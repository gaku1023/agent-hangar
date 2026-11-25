import type { PeerChatAsk } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import type { PaneKey } from '../../tmux/pane.ts';
import { createPeerAnswerer, type AnswerPane } from './answer.ts';
import { pendingAskFrom } from './hostView.ts';
import type { HostSession } from './hostTypes.ts';

// フォルダの信頼の確認への答え。番号の無い形（カーソルの初期位置は No, exit）と、番号付きの形（2.1.295 ごろ）の両方を、キー列で確かめる。

type Form = 'plain' | 'numbered';

/** 偽の確認の画面。up と down でカーソルが動き、Enter で確定すると画面が閉じる（No なら claude が終わる）。 */
class FakeTrust implements AnswerPane {
  events: string[] = [];
  cursor: number;
  result: 'yes' | 'no' | null = null;
  constructor(readonly form: Form, readonly dir = 'D:\\workspace\\ops', readonly order: ('yes' | 'no')[] = form === 'plain' ? ['no', 'yes'] : ['yes', 'no'], readonly showCursor = true) {
    this.cursor = 0;
  }
  capture(): string {
    if (this.result) return '╭──╮\n│ ✻ Welcome to Claude Code │\n❯ ';
    const label = (k: 'yes' | 'no') => (k === 'yes' ? 'Yes, I trust this folder' : 'No, exit');
    const rows = this.order.map((k, i) => `${i === this.cursor && this.showCursor ? ' ❯ ' : '   '}${this.form === 'numbered' ? `${i + 1}. ` : ''}${label(k)}`);
    return [' Accessing workspace:', '', ' ' + this.dir, '', ' Quick safety check: Is this a project you created or one you trust?', '', ...rows, '', ' Enter to confirm · Esc to cancel', ''].join('\n');
  }
  sendKey(key: PaneKey): void {
    this.events.push(key);
    if (key === 'down') this.cursor = Math.min(1, this.cursor + 1);
    else if (key === 'up') this.cursor = Math.max(0, this.cursor - 1);
    else if (key === 'enter') this.result = this.order[this.cursor]!;
  }
  sendText(text: string): void { this.events.push(`text:${text}`); }
}

const session = { provider: 'claude-code', live: 'waiting', aside: false, waitingFor: 'permission', permission: { tool: 'FolderTrust', input: 'D:\\workspace\\ops', description: null }, activity: null, cwd: 'D:\\workspace\\ops', lock: false, newerElsewhere: false, remoteOnly: false, takenOver: false } satisfies HostSession;

function askOf(pane: FakeTrust): PeerChatAsk {
  const p = pendingAskFrom(session, pane.capture())!;
  return { askId: 'a1', kind: p.kind, tool: p.tool, input: p.input, options: p.options, multi: p.multi, allowText: p.allowText };
}
const answerer = (pane: FakeTrust) => createPeerAnswerer({ pane: () => pane, sleep: async () => {}, now: () => 0 });

describe('フォルダの信頼の札', () => {
  it('画面から permission の札を組む。道具は FolderTrust、input はパス、選択肢は画面のラベルで Yes が 1、No が 2', () => {
    const plain = pendingAskFrom(session, new FakeTrust('plain').capture())!;
    expect(plain).toMatchObject({ kind: 'permission', tool: 'FolderTrust', input: 'D:\\workspace\\ops', multi: false, allowText: false });
    expect(plain.options).toEqual([{ key: '2', label: 'No, exit' }, { key: '1', label: 'Yes, I trust this folder' }]);
    expect(plain.answerable).toBeUndefined();
    const numbered = pendingAskFrom(session, new FakeTrust('numbered').capture())!;
    expect(numbered.options).toEqual([{ key: '1', label: 'Yes, I trust this folder' }, { key: '2', label: 'No, exit' }]);
  });
});

describe('フォルダの信頼の確認に答える', () => {
  it('No にカーソルがあるとき Yes を選ぶと down、enter の順に打つ（番号の無い形）', async () => {
    const pane = new FakeTrust('plain');
    const r = await answerer(pane).answerAsk('r', askOf(pane), ['1']);
    expect(r).toEqual({ ok: true, label: 'Yes, I trust this folder' });
    expect(pane.events).toEqual(['down', 'enter']);
    expect(pane.result).toBe('yes');
  });
  it('カーソルがもう選んだ行にあれば enter だけ打つ', async () => {
    const pane = new FakeTrust('numbered');
    const r = await answerer(pane).answerAsk('r', askOf(pane), ['1']);
    expect(r.ok).toBe(true);
    expect(pane.events).toEqual(['enter']);
    expect(pane.result).toBe('yes');
  });
  it('番号付きの形で No を選ぶと down、enter。No で claude が終わっても答えたことになる', async () => {
    const pane = new FakeTrust('numbered');
    const r = await answerer(pane).answerAsk('r', askOf(pane), ['2']);
    expect(r).toEqual({ ok: true, label: 'No, exit' });
    expect(pane.events).toEqual(['down', 'enter']);
    expect(pane.result).toBe('no');
  });
  it('上の行へは up を打つ', async () => {
    const pane = new FakeTrust('numbered');
    pane.cursor = 1;
    const r = await answerer(pane).answerAsk('r', askOf(pane), ['1']);
    expect(r.ok).toBe(true);
    expect(pane.events).toEqual(['up', 'enter']);
  });
  it('札のフォルダが画面と違えば、何も打たずに断る', async () => {
    const pane = new FakeTrust('plain');
    const ask = { ...askOf(pane), input: 'D:\\other' };
    const r = await answerer(pane).answerAsk('r', ask, ['1']);
    expect(r).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(pane.events).toEqual([]);
  });
  it('確認がもう閉じていれば、何も打たずに断る', async () => {
    const pane = new FakeTrust('plain');
    const ask = askOf(pane);
    pane.result = 'yes';
    expect(await answerer(pane).answerAsk('r', ask, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(pane.events).toEqual([]);
  });
  it('カーソルが読めないときは、何も打たずに断る（No に当たると claude が終わる）', async () => {
    const pane = new FakeTrust('plain', 'D:\\workspace\\ops', ['no', 'yes'], false);
    const ask = { askId: 'a1', kind: 'permission', tool: 'FolderTrust', input: 'D:\\workspace\\ops', options: [{ key: '2', label: 'No, exit' }, { key: '1', label: 'Yes, I trust this folder' }], multi: false, allowText: false } satisfies PeerChatAsk;
    expect(await answerer(pane).answerAsk('r', ask, ['1'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(pane.events).toEqual([]);
  });
  it('札に無い key や、文字つきの答えは断る', async () => {
    const pane = new FakeTrust('plain');
    const a = answerer(pane);
    expect(await a.answerAsk('r', askOf(pane), ['3'])).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(await a.answerAsk('r', askOf(pane), ['1'], 'x')).toEqual({ ok: false, reason: 'ask-mismatch' });
    expect(pane.events).toEqual([]);
  });
  it('同じ札に 2 度は打たない', async () => {
    const pane = new FakeTrust('plain');
    const a = answerer(pane);
    const ask = askOf(pane);
    await a.answerAsk('r', ask, ['1']);
    expect(await a.answerAsk('r', ask, ['1'])).toEqual({ ok: false, reason: 'already-answered' });
  });
});
