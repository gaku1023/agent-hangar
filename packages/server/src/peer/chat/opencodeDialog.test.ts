import { describe, expect, it } from 'vitest';
import type { AgentAskQuestion, AgentPendingAsk } from '../../agent/pendingAsk.ts';
import { opencodeScreenKeys, readOpencodeDialog } from './opencodeDialog.ts';
import {
  OPENCODE_FORM_ASK,
  OPENCODE_FORM_ASK_80,
  OPENCODE_FORM_CLOSED,
  OPENCODE_FORM_MULTI,
  OPENCODE_FORM_SUBMIT,
  OPENCODE_PERM_ALWAYS_SEL,
  OPENCODE_PERM_ASK,
  OPENCODE_PERM_ASK_80,
  OPENCODE_PERM_CLOSED,
  OPENCODE_PERM_OTHER,
  OPENCODE_PERM_REJECT_SEL,
} from './dialogs.opencode.fixtures.ts';

const permAsk = (input: string): AgentPendingAsk => ({ provider: 'opencode', stableId: 'p', api: null, kind: 'permission', tool: 'shell', input, choices: [], questions: [] });
const perm = (choice: 'once' | 'session' | 'deny' | 'deny-stop') => ({ kind: 'permission' as const, choice });

function field(over: Partial<AgentAskQuestion> = {}): AgentAskQuestion {
  return {
    id: 'lang',
    text: 'Which language?',
    kind: 'choice',
    options: [
      { key: 'English', label: 'English' },
      { key: 'Japanese', label: 'Japanese' },
    ],
    multi: false,
    allowText: true,
    required: true,
    ...over,
  };
}
const formAsk = (qs: AgentAskQuestion[]): AgentPendingAsk => ({ provider: 'opencode', stableId: 'f', api: null, kind: 'question', choices: [], questions: qs });
const answer = (id: string, value: string) => ({ kind: 'question' as const, answers: { [id]: value } });
// 実物は 2 つの欄（Language と Toppings）。欄が 1 つの form は未採取なので、タブの行の Toppings を除いた派生で確かめる。
const oneField = (s: string): string => s.replace(/\x1b\[[0-9;:]*m/g, '').replace('Language  Toppings  Submit', 'Language  Submit');

describe('readOpencodeDialog（opencode 2.2.0 の実物）', () => {
  it('許可の札を読む。既定は Allow once が塗られている（120 桁と 80 桁）', () => {
    for (const s of [OPENCODE_PERM_ASK, OPENCODE_PERM_ASK_80]) {
      expect(readOpencodeDialog(s)).toEqual({ kind: 'permission', command: 'echo hi > a.txt', alwaysPreview: false, selected: 'Allow once' });
    }
  });

  it('→ で選びが動いた画面は、塗りから読む。Always allow の本文は命令を持たない', () => {
    expect(readOpencodeDialog(OPENCODE_PERM_ALWAYS_SEL)).toMatchObject({ kind: 'permission', command: null, alwaysPreview: true, selected: 'Always allow' });
    expect(readOpencodeDialog(OPENCODE_PERM_REJECT_SEL)).toMatchObject({ kind: 'permission', command: 'touch z.txt', selected: 'Reject' });
  });

  it('色が無い画面でも読めるが、選びは null（色に頼る所）', () => {
    const noColor = OPENCODE_PERM_ASK.replace(/\x1b\[[0-9;:]*m/g, '');
    expect(readOpencodeDialog(noColor)).toMatchObject({ kind: 'permission', command: 'echo hi > a.txt', selected: null });
  });

  it('form を読む。1 つ選ぶ欄と複数選択の欄、Type your own answer は選択肢に入れない', () => {
    for (const s of [OPENCODE_FORM_ASK, OPENCODE_FORM_ASK_80]) {
      expect(readOpencodeDialog(s)).toEqual({
        kind: 'form',
        fields: 2,
        hasSubmitTab: true,
        text: 'Which language?',
        multi: false,
        options: [
          { number: 1, label: 'English' },
          { number: 2, label: 'Japanese' },
        ],
        allowText: true,
      });
    }
    expect(readOpencodeDialog(OPENCODE_FORM_MULTI)).toMatchObject({ kind: 'form', multi: true, text: 'Which toppings?', options: [{ number: 1, label: 'cheese' }, { number: 2, label: 'ham' }, { number: 3, label: 'olive' }] });
  });

  it('札の無い画面（閉じた後）、Submit のタブは null', () => {
    for (const s of [OPENCODE_PERM_CLOSED, OPENCODE_FORM_CLOSED, OPENCODE_FORM_SUBMIT, '', 'hello']) expect(readOpencodeDialog(s)).toBeNull();
  });
});

describe('opencodeScreenKeys（許可）', () => {
  it('once は Enter、always は Right Enter、reject は Right Right Enter。80 桁でも同じ', () => {
    for (const s of [OPENCODE_PERM_ASK, OPENCODE_PERM_ASK_80]) {
      const ask = permAsk('echo hi > a.txt');
      expect(opencodeScreenKeys(s, ask, perm('once'))).toEqual(['enter']);
      expect(opencodeScreenKeys(s, ask, perm('session'))).toEqual(['right', 'enter']);
      expect(opencodeScreenKeys(s, ask, perm('deny'))).toEqual(['right', 'right', 'enter']);
      expect(opencodeScreenKeys(s, ask, perm('deny-stop'))).toEqual(['right', 'right', 'enter']);
    }
  });

  it('命令の文が違う見本では打たない', () => {
    expect(opencodeScreenKeys(OPENCODE_PERM_OTHER, permAsk('echo hi > a.txt'), perm('once'))).toBeNull();
    expect(opencodeScreenKeys(OPENCODE_PERM_ASK, permAsk('touch z.txt'), perm('once'))).toBeNull();
    expect(opencodeScreenKeys(OPENCODE_PERM_ASK, permAsk(''), perm('once'))).toBeNull();
    expect(opencodeScreenKeys(OPENCODE_PERM_ASK, permAsk('echo hi > a.txt\ncat b'), perm('once'))).toBeNull();
  });

  it('既定が Allow once でない（選びが動いている、塗りが読めない）なら打たない', () => {
    expect(opencodeScreenKeys(OPENCODE_PERM_REJECT_SEL, permAsk('touch z.txt'), perm('once'))).toBeNull();
    expect(opencodeScreenKeys(OPENCODE_PERM_ALWAYS_SEL, permAsk('echo hi > a.txt'), perm('once'))).toBeNull();
    const noColor = OPENCODE_PERM_ASK.replace(/\x1b\[[0-9;:]*m/g, '');
    expect(opencodeScreenKeys(noColor, permAsk('echo hi > a.txt'), perm('once'))).toBeNull();
  });

  it('札の無い画面では null', () => {
    expect(opencodeScreenKeys(OPENCODE_PERM_CLOSED, permAsk('touch z.txt'), perm('once'))).toBeNull();
  });
});

describe('opencodeScreenKeys（form）', () => {
  it('欄が 2 つの form は null（1 つ目でも）', () => {
    const asks = formAsk([field(), field({ id: 'top', text: 'Which toppings?', multi: true })]);
    expect(opencodeScreenKeys(OPENCODE_FORM_ASK, asks, answer('lang', 'English'))).toBeNull();
    expect(opencodeScreenKeys(OPENCODE_FORM_ASK, formAsk([field()]), answer('lang', 'English'))).toBeNull();
  });

  it('欄が 1 つなら番号キーと Enter を返す（派生の画面。Enter は推定）', () => {
    for (const s of [oneField(OPENCODE_FORM_ASK), oneField(OPENCODE_FORM_ASK_80)]) {
      expect(opencodeScreenKeys(s, formAsk([field()]), answer('lang', 'English'))).toEqual(['1', 'enter']);
      expect(opencodeScreenKeys(s, formAsk([field()]), answer('lang', 'Japanese'))).toEqual(['2', 'enter']);
    }
  });

  it('問いの文や選択肢が違う、複数選択、自由記述、伏せた値は null', () => {
    const s = oneField(OPENCODE_FORM_ASK);
    expect(opencodeScreenKeys(s, formAsk([field({ text: 'Other?' })]), answer('lang', 'English'))).toBeNull();
    expect(opencodeScreenKeys(s, formAsk([field({ multi: true })]), answer('lang', 'English'))).toBeNull();
    expect(opencodeScreenKeys(s, formAsk([field({ secret: true })]), answer('lang', 'English'))).toBeNull();
    expect(opencodeScreenKeys(s, formAsk([field({ kind: 'text', options: [] })]), answer('lang', 'English'))).toBeNull();
    expect(opencodeScreenKeys(s, formAsk([field()]), answer('lang', 'French'))).toBeNull();
    expect(opencodeScreenKeys(oneField(OPENCODE_FORM_MULTI), formAsk([field({ id: 'top', text: 'Which toppings?', multi: true })]), answer('top', 'cheese'))).toBeNull();
  });

  it('閉じた後は null', () => {
    expect(opencodeScreenKeys(OPENCODE_FORM_CLOSED, formAsk([field()]), answer('lang', 'English'))).toBeNull();
  });
});
