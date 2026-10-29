import { describe, expect, it } from 'vitest';
import type { LinkConflictsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { codexAccountsFixture } from '../test/accounts.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentLinkRepair } from './linkRepair.ts';

const store: Store = { ...initialStore(), accounts: codexAccountsFixture };
const MINE_AT = new Date(2026, 9, 29, 8, 40).getTime();
const SHARED_AT = new Date(2026, 9, 28, 21, 5).getTime();
const detail = (over: Partial<LinkConflictsDto['entries'][number]> = {}): LinkConflictsDto => ({
  accountId: 'a1', agent: 'claude-code',
  entries: [{ name: 'settings.json', kind: 'file', mine: { text: 'a\nmine\nc', mtimeMs: MINE_AT, size: 8 }, shared: { text: 'a\nshared\nc', mtimeMs: SHARED_AT, size: 10 }, ...over }],
});
const open = (d: LinkConflictsDto | null, over: Partial<State['linkRepair']> = {}): State => ({
  ...initialState(),
  overlay: { kind: 'linkRepair', agent: 'claude-code', accountId: 'a1', back: null },
  linkRepair: { detail: d, working: false, error: null, ...over },
});

describe('presentLinkRepair', () => {
  it('調査へ渡す事情は、修復の失敗の文、無ければアカウントの注意の文と、項目の名前', () => {
    const problem: Store = { ...store, accounts: { ...codexAccountsFixture, accounts: codexAccountsFixture.accounts.map((a) => (a.id === 'a1' ? { ...a, linkProblem: 'settings.json が外れています' } : a)) } };
    expect(presentLinkRepair(open(detail()), problem)!.investigate).toEqual({ op: 'linkRepair', message: 'settings.json が外れています', agent: 'claude-code', accountId: 'a1', files: ['settings.json'] });
    expect(presentLinkRepair(open(detail(), { error: 'EACCES: permission denied' }), problem)!.investigate.message).toBe('EACCES: permission denied');
  });
  it('ダイアログを開いていなければ null', () => {
    expect(presentLinkRepair(initialState(), store)).toBeNull();
  });
  it('読む前は読み込み中で、札は無い。アカウントの名前は一覧から引く', () => {
    const p = presentLinkRepair(open(null), store)!;
    expect(p).toMatchObject({ account: '大学', loading: true, cards: [], names: '', working: false, error: null });
  });
  it('Codex は Codex の一覧から名前を引く', () => {
    const s: State = { ...open(null), overlay: { kind: 'linkRepair', agent: 'codex', accountId: 'cw', back: null } };
    expect(presentLinkRepair(s, store)!.account).toBe('会社用');
  });
  it('札は、名前、2 つの更新時刻、共有から手元への行の差分を持つ', () => {
    const p = presentLinkRepair(open(detail()), store)!;
    expect(p.loading).toBe(false);
    expect(p.names).toBe('settings.json');
    expect(p.cards).toEqual([{
      name: 'settings.json', mineWhen: '2026-10-29 08:40', sharedWhen: '2026-10-28 21:05',
      lines: [{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'shared' }, { kind: 'add', text: 'mine' }, { kind: 'ctx', text: 'c' }],
    }]);
  });
  it('どちらかの本文が無い（大きい、バイナリ）ときは、差分を持たない', () => {
    const p = presentLinkRepair(open(detail({ mine: { text: null, mtimeMs: MINE_AT, size: 9_999_999 } })), store)!;
    expect(p.cards[0]!.lines).toBeNull();
  });
  it('項目が複数なら、名前を読点でつなぐ。直している最中と理由をそのまま渡す', () => {
    const d = detail();
    const two: LinkConflictsDto = { ...d, entries: [d.entries[0]!, { ...d.entries[0]!, name: 'CLAUDE.md' }] };
    const p = presentLinkRepair(open(two, { working: true, error: '断られました' }), store)!;
    expect(p.names).toBe('settings.json、CLAUDE.md');
    expect(p).toMatchObject({ working: true, error: '断られました' });
  });
  it('読めなかったときは、読み込み中ではなく理由を出す', () => {
    const p = presentLinkRepair(open(null, { error: '読めません' }), store)!;
    expect(p).toMatchObject({ loading: false, error: '読めません' });
  });
});
