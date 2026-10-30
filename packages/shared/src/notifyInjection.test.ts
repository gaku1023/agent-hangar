import { describe, expect, it } from 'vitest';
import { translator } from './i18n/t.ts';
import { notifyOsLabel, notifyRulesLine } from './notifyInjection.ts';

describe('notifyRulesLine', () => {
  it('出し先ごとに kind の名前を並べ、空の出し先は出さないと言う', () => {
    expect(notifyRulesLine(translator('ja'), { unread: ['done', 'ask', 'progress'], os: ['done', 'ask'], phone: [] })).toBe('unread は done・ask・progress、os は done・ask、phone は 出さない');
    expect(notifyRulesLine(translator('en'), { unread: ['done'], os: [], phone: ['ask'] })).toBe('unread: done; os: none; phone: ask');
  });
});
describe('notifyOsLabel', () => {
  it('Windows の PC は Windows、それ以外は Mac', () => {
    expect(notifyOsLabel('win32')).toBe('Windows');
    expect(notifyOsLabel('darwin')).toBe('Mac');
    expect(notifyOsLabel(undefined)).toBe('Mac');
  });
});
