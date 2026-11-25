import { describe, expect, it } from 'vitest';
import { REMOTE_SHELL_FAILURES, translator, type RemoteTabDto, type SessionDto } from '@agent-hangar/shared';
import { en } from '../../../shared/src/i18n/en.ts';
import { ja } from '../../../shared/src/i18n/ja.ts';
import { initialState } from '../mediator/transition.ts';
import { defaultSessionView } from '../mediator/sessionView.ts';
import { initialStore, type Store } from '../store/store.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { investigateSeed } from './investigate.ts';
import { presentSession } from './session.ts';
import { PEER_CHAT_TAB, REASON_KEY, presentRemoteShell, remoteBusy } from './remoteShell.ts';

const t = translator('ja');
const NOW = Date.UTC(2026, 10, 25, 3, 0, 0);

describe('presentRemoteShell', () => {
  it('札がまだ無い間と connecting は、つないでいる途中として輪を出し、端末は薄めない', () => {
    for (const link of [null, { phase: 'connecting' as const }]) {
      const f = presentRemoteShell(link, 'Win', t);
      expect(f).toMatchObject({ phase: 'connecting', busy: true, dim: false, why: null });
    }
  });
  it('ready は輪を出さない', () => {
    expect(presentRemoteShell({ phase: 'ready' }, 'Win', t)).toMatchObject({ phase: 'ready', busy: false, dim: false });
  });
  it('retrying は輪を出し、端末を薄める', () => {
    expect(presentRemoteShell({ phase: 'retrying', attempt: 2 }, 'Win', t)).toMatchObject({ phase: 'retrying', busy: true, dim: true });
  });
  it('failed は理由の文と detail と宛先を持ち、輪は出さない', () => {
    const f = presentRemoteShell({ phase: 'failed', reason: 'unreachable', detail: 'timed out', address: '100.1.2.3' }, 'Win', t);
    expect(f).toMatchObject({ phase: 'failed', busy: false, dim: false, reason: 'unreachable', detail: 'timed out', address: '100.1.2.3' });
    expect(f.why).toContain('Win');
  });
  it('理由が欠けた failed は dropped として扱う', () => {
    expect(presentRemoteShell({ phase: 'failed' }, 'Win', t).reason).toBe('dropped');
  });
  it('remoteBusy は connecting と retrying と札の無い間だけ真', () => {
    expect([null, { phase: 'connecting' }, { phase: 'retrying' }, { phase: 'ready' }, { phase: 'failed' }].map((l) => remoteBusy(l as never))).toEqual([true, true, true, false, false]);
  });
  it('理由 9 種の文が ja と en の辞書にそろっている', () => {
    for (const r of REMOTE_SHELL_FAILURES) {
      expect((ja as Record<string, string>)[REASON_KEY[r]], r).toBeTruthy();
      expect((en as Record<string, string>)[REASON_KEY[r]], r).toBeTruthy();
    }
  });
});

const tab = (over: Partial<RemoteTabDto> = {}): RemoteTabDto => ({ id: 'rt1', sessionId: 's1', deviceId: 'd-win', title: 'シェル', createdAt: 1, ...over });
function storeWith(tabs: RemoteTabDto[]): Store {
  const st = initialStore();
  st.bootstrapped = true;
  st.device = { id: 'me', name: 'Mac' };
  st.sessions = { s1: sessionDto({ name: 'x', cwd: '/w', provider: 'claude-code', remoteOnly: true }) as SessionDto };
  st.remoteTabs = Object.fromEntries(tabs.map((x) => [x.id, x]));
  st.remoteHosts = { 'd-win': 'win-box' };
  st.devices = [{ id: 'd-win', name: 'Win' } as never];
  return st;
}
const propsOf = (st: Store, peerTab: string | null = null) => {
  const state = initialState();
  state.sessionView = { s1: { ...defaultSessionView(), peerTab } };
  return presentSession(state, st, NOW, 's1');
};

describe('presentSession の peerShell', () => {
  it('チャット本体のタブ、remote のタブの順に並べ、本体が選ばれている', () => {
    const p = propsOf(storeWith([tab(), tab({ id: 'rt2', createdAt: 2 })]));
    expect(p.peerShell?.tabs.map((x) => [x.id, x.kind, x.selected, x.closable])).toEqual([[PEER_CHAT_TAB, 'agent', true, false], ['rt1', 'remote', false, true], ['rt2', 'remote', false, true]]);
    expect(p.peerShell?.shell).toBeNull();
  });
  it('選んだ remote のタブは selected で、宛先の PC と上書きの Host を持つ', () => {
    const p = propsOf(storeWith([tab()]), 'rt1');
    expect(p.peerShell?.tabs.map((x) => x.selected)).toEqual([false, true]);
    expect(p.peerShell?.shell).toEqual({ tabId: 'rt1', deviceId: 'd-win', deviceName: 'Win', host: 'win-box' });
  });
  it('保存された peerTab が閉じたタブを指していたら本体を出す', () => {
    const p = propsOf(storeWith([tab()]), 'gone');
    expect(p.peerShell?.tabs[0]?.selected).toBe(true);
    expect(p.peerShell?.shell).toBeNull();
  });
  it('別の会話のタブは並べない', () => {
    const p = propsOf(storeWith([tab({ sessionId: 's2' })]));
    expect(p.peerShell?.tabs.map((x) => x.id)).toEqual([PEER_CHAT_TAB]);
  });
});

describe('investigateSeed: remoteShell', () => {
  it('引用に PC 名と宛先と detail を入れる', () => {
    const seed = investigateSeed(initialStore(), { op: 'remoteShell', message: '鍵が通りません', code: 'auth', remote: { device: 'Win', address: '100.1.2.3', detail: 'Permission denied (publickey).' } });
    expect(seed.quote).toContain('Win');
    expect(seed.quote).toContain('100.1.2.3');
    expect(seed.quote).toContain('Permission denied (publickey).');
    expect(seed.quote).toContain('鍵が通りません');
  });
});
