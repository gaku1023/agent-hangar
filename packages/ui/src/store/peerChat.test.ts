import { describe, expect, it } from 'vitest';
import type { PeerChatItem } from '@agent-hangar/shared';
import { upsertItems } from './peerChat.ts';

const item = (uuid: string): PeerChatItem => ({ uuid, at: 1, kind: 'assistant', text: uuid });
const ask = (uuid: string, askId: string, answered = false): PeerChatItem => ({
  uuid, at: 2, kind: 'permission', text: 'run it?',
  ask: { askId, kind: 'permission', options: [{ key: '1', label: 'Yes' }], multi: false, allowText: false, ...(answered ? { answered: { by: { deviceId: 'pc-b', deviceName: 'Mac' }, label: 'Yes', at: 3 } } : {}) },
});
const uuids = (items: PeerChatItem[]): string[] => items.map((i) => i.uuid);

describe('upsertItems: 札の並び', () => {
  it('あとから来た答え済みの札は、末尾ではなく、札が呼んだ位置（直前の項目の直後）に入る', () => {
    const out = upsertItems([item('u1'), item('u2'), item('u3')], [ask('u1@ask:A', 'A', true)]);
    expect(uuids(out)).toEqual(['u1', 'u1@ask:A', 'u2', 'u3']);
  });

  it('いま出ている札は、いつもどおり末尾', () => {
    expect(uuids(upsertItems([item('u1')], [item('u2'), ask('u2@ask:A', 'A')]))).toEqual(['u1', 'u2', 'u2@ask:A']);
  });

  it('同じ位置の札が重なっても、答えた順のまま。直前の項目が無ければ末尾', () => {
    const a = upsertItems([item('u1'), item('u2')], [ask('u1@ask:A', 'A', true)]);
    expect(uuids(upsertItems(a, [ask('u1@ask:B', 'B', true)]))).toEqual(['u1', 'u1@ask:A', 'u1@ask:B', 'u2']);
    expect(uuids(upsertItems([item('u1')], [ask('zz@ask:C', 'C', true)]))).toEqual(['u1', 'zz@ask:C']);
  });

  it('同じ uuid や askId の札は、位置を変えずに置き換える（答えが付く、! が外れる、言い換え）', () => {
    const base = [item('u1'), ask('u1@ask:A!', 'A'), item('u2')];
    expect(uuids(upsertItems(base, [ask('u1@ask:A', 'A', true)]))).toEqual(['u1', 'u1@ask:A', 'u2']);
    expect(upsertItems(base, [ask('u1@ask:A', 'A', true)])[1]!.ask!.answered).toBeDefined();
    expect(uuids(upsertItems(base, [ask('u1@ask:A!', 'A', true)]))).toEqual(['u1', 'u1@ask:A!', 'u2']);
  });
});
