import { describe, expect, it } from 'vitest';
import type { EventFacts, HeldEventDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';
import { presentHeldEvents } from './heldEvents.ts';

const SYNC = { state: 'ok', revoked: false, workerCompat: 12 } as never;
const fact = (over: Partial<EventFacts> = {}): EventFacts => ({ source: 'github', event: 'ci_done', repo: 'octo/demo', number: 7, outcome: 'success', receivedAt: 1, ...over });
const held = (bindingId: string, ...facts: EventFacts[]): HeldEventDto => ({ bindingId, facts });
const store = (h: HeldEventDto[], sync: unknown = SYNC): Store => ({ ...initialStore(), sync: sync as never, heldEvents: h });
const present = (s: Store) => presentHeldEvents(s, translatorOf(s));

describe('溜まったイベントの札（presentHeldEvents）', () => {
  it('溜まったものが無ければ札を出さない', () => {
    expect(present(store([]))).toBeNull();
    expect(present(store([held('b1')]))).toBeNull();
  });
  it('イベントを使えない PC（クラウドなし、Worker が古い、解除済み）では、溜まっていても出さない', () => {
    const h = [held('b1', fact())];
    for (const sync of [null, { state: 'off', revoked: false, workerCompat: 12 }, { state: 'ok', revoked: true, workerCompat: 12 }, { state: 'ok', revoked: false, workerCompat: 11 }]) {
      expect(present(store(h, sync))).toBeNull();
    }
  });
  it('見出しは全体の件数（決めた文面 w22）で、結び付けごとに畳んだ群を古い順のまま並べる', () => {
    const p = present(store([
      held('b1', fact({ number: 7 }), fact({ number: 7, outcome: 'failure' }), fact({ number: 7, event: 'merged', outcome: undefined })),
      held('b2', fact({ source: 'hook', event: 'hook', repo: undefined, number: undefined, outcome: undefined })),
    ]))!;
    expect(p.head).toBe('閉じている間に 4 件のイベントが届きました');
    expect(p.groups.map((g) => [g.bindingId, g.label, g.count])).toEqual([['b1', 'octo/demo #7', 3], ['b2', 'webhook', 1]]);
    expect(p.groups[0]!.items.map((i) => i.text)).toEqual(['CI 完了', 'CI 失敗', 'マージ']);
    expect(p.groups[1]!.items.map((i) => i.text)).toEqual(['webhook']);
    expect(p.groups[0]!.items.every((i) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(i.at))).toBe(true);
  });
  it('本文や題名は見せない（外から来た文を札に出さない）', () => {
    const p = present(store([held('b1', fact({ title: '悪意のある題名', body: '本文', actor: 'someone' }))]))!;
    expect(JSON.stringify(p)).not.toContain('悪意');
    expect(JSON.stringify(p)).not.toContain('本文');
  });
});
