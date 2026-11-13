import { afterEach, describe, expect, it } from 'vitest';
import { notifyApp, onAppNotice, type AppNotice } from './appNotice.ts';

/**
 * セッションに紐づかない知らせ（計画の受け入れの試験 11 の振り分け側）。
 * 出し先は notifyRulesOf の os と phone に従い、unread は使わない。
 */

const got: AppNotice[] = [];
let off: () => void = () => {};
afterEach(() => { off(); got.length = 0; });
const listen = (): void => { off = onAppNotice((n) => got.push(n)); };

describe('notifyApp', () => {
  it('既定の決まりでは ask が os と phone に振り分けられる（unread は含めない）', () => {
    listen();
    notifyApp({ text: '確認が 1 件あります', kind: 'ask' });
    expect(got).toEqual([{ text: '確認が 1 件あります', kind: 'ask', sent: ['os', 'phone'] }]);
  });

  it('利用者の決まりで os が ask を含まなければ、os へは出さない', () => {
    listen();
    notifyApp({ text: 'x', kind: 'ask' }, { notifyPreference: { text: '', unread: ['ask'], os: ['done'], phone: ['ask'], whileFocused: false } });
    expect(got).toEqual([{ text: 'x', kind: 'ask', sent: ['phone'] }]);
  });

  it('出し先が 1 つも無ければ配らない', () => {
    listen();
    notifyApp({ text: 'x', kind: 'ask' }, { notifyPreference: { text: '', unread: ['ask'], os: [], phone: [], whileFocused: false } });
    expect(got).toEqual([]);
  });

  it('外すと配らない。聞き手が投げても書いた側へ波及しない', () => {
    const off2 = onAppNotice(() => { throw new Error('boom'); });
    listen();
    notifyApp({ text: 'a', kind: 'ask' });
    off2();
    off();
    notifyApp({ text: 'b', kind: 'ask' });
    expect(got.map((n) => n.text)).toEqual(['a']);
  });
});
