import { describe, expect, it } from 'vitest';
import type { CodexStatusDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentCodexVersionCard } from './codexNotice.ts';
import { presentToasts } from './toasts.ts';

const storeOf = (status: CodexStatusDto | null, enabled = true): Store => ({ ...initialStore(), settings: { ...(initialStore().settings ?? {}), codexEnabled: enabled } as SettingsDto, codexStatus: status });
const found = (version: string | null, verified = false): CodexStatusDto => ({ found: true, version, verified, loggedIn: true });

describe('未検証の Codex の版の札（C4、opencode の C7 と同じ決まり）', () => {
  it('範囲の外の版なら、見出し・題・本文・操作をそろえて出す', () => {
    expect(presentCodexVersionCard(initialState(), storeOf(found('0.170.0')))).toEqual({
      version: '0.170.0', head: '未検証のバージョン', who: 'codex 0.170.0', title: 'codex 0.170.0 は未検証のバージョンです',
      body: '検証済み：0.165.x。app-server の変更により、状態や権限確認が正しく表示されない可能性があります。', settings: '設定を開く', proceed: 'このまま続行',
    });
  });
  it('同じ版は閉じたら出さない。版が変われば、また出す', () => {
    expect(presentCodexVersionCard({ ...initialState(), codexVersionSeen: '0.170.0' }, storeOf(found('0.170.0')))).toBeNull();
    expect(presentCodexVersionCard({ ...initialState(), codexVersionSeen: '0.170.0' }, storeOf(found('0.171.0')))).not.toBeNull();
  });
  it('設定で有効にしていないとき、検証済み、版が読めない、見つからない、答えが届く前は出さない', () => {
    expect(presentCodexVersionCard(initialState(), storeOf(found('0.170.0'), false))).toBeNull();
    for (const s of [found('0.165.2', true), found(null), { found: false, version: null, verified: false, loggedIn: false }, null]) expect(presentCodexVersionCard(initialState(), storeOf(s)), JSON.stringify(s)).toBeNull();
  });
  it('設定の連携の節を開いている間は出さない', () => {
    const at: State = { ...initialState(), screen: { name: 'settings', at: 'codex' } };
    expect(presentCodexVersionCard(at, storeOf(found('0.170.0')))).toBeNull();
    expect(presentCodexVersionCard({ ...initialState(), screen: { name: 'settings', at: 'about' } }, storeOf(found('0.170.0')))).not.toBeNull();
  });
  it('右下の知らせに載る', () => {
    expect(presentToasts(initialState(), storeOf(found('0.170.0')), 0).codexVersion?.version).toBe('0.170.0');
    expect(presentToasts(initialState(), storeOf(found('0.165.2', true)), 0).codexVersion).toBeNull();
  });
});
