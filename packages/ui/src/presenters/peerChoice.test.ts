import { describe, expect, it } from 'vitest';
import type { PeerDeviceDto } from '@agent-hangar/shared';
import { peerAccountOptions, peerAccountPick, peerAgentState, peerMark, peerProjectState, type PeerAccountRow } from './peerChoice.ts';

const peer = (over: Partial<PeerDeviceDto> = {}): PeerDeviceDto => ({
  id: 'pc-b', name: 'Mac', platform: 'darwin', state: 'ready',
  accounts: [{ name: 'Work', agent: 'claude-code', loggedIn: true }, { name: 'Old', agent: 'claude-code', loggedIn: false }, { name: 'Sub', agent: 'codex', loggedIn: true }],
  agents: ['claude-code', 'codex'], projects: ['p1'], ...over,
});

describe('peerMark（PC の印）', () => {
  it('頼めない PC だけ印を持つ。つながらない PC は offline、古い版は outdated', () => {
    expect(peerMark(peer())).toBeNull();
    expect(peerMark(peer({ state: 'offline' }))).toBe('offline');
    expect(peerMark(peer({ state: 'outdated' }))).toBe('outdated');
  });
});

describe('peerProjectState と peerAgentState', () => {
  it('置き場のあるプロジェクトだけ ok。クイックセッション（null）は常に ok', () => {
    expect(peerProjectState(peer(), 'p1')).toBe('ok');
    expect(peerProjectState(peer(), 'p2')).toBe('missing');
    expect(peerProjectState(peer(), null)).toBe('ok');
  });
  it('入っているエージェントだけ ok', () => {
    expect(peerAgentState(peer(), 'codex')).toBe('ok');
    expect(peerAgentState(peer({ agents: ['claude-code'] }), 'codex')).toBe('missing');
  });
});

describe('peerAccountOptions（選べるものを先に、選べないものを末尾に集める）', () => {
  const local = [{ name: 'Main', id: 'a1' }, { name: 'Work', id: 'a2' }];
  const rows = (agent: string, l = local): PeerAccountRow[] => peerAccountOptions(peer(), agent, l);
  it('この PC のアカウントと相手のアカウントを名前で合わせ、相手に無いものは missing、ログアウトは loggedOut', () => {
    expect(rows('claude-code')).toEqual([
      { name: 'Work', state: 'ok', localId: 'a2' },
      { name: 'Main', state: 'missing', localId: 'a1' },
      { name: 'Old', state: 'loggedOut', localId: null },
    ]);
  });
  it('エージェントが違えば別のアカウント（名前が同じでも）', () => {
    expect(rows('codex', [{ name: 'Sub', id: 'c1' }]).map((r) => [r.name, r.state])).toEqual([['Sub', 'ok']]);
    expect(rows('codex').map((r) => [r.name, r.state])).toEqual([['Sub', 'ok'], ['Main', 'missing'], ['Work', 'missing']]);
  });
  it('opencode はアカウントを持たない', () => {
    expect(rows('opencode')).toEqual([]);
  });
});

describe('peerAccountPick（札の値）', () => {
  const rows: PeerAccountRow[] = [{ name: 'Work', state: 'ok', localId: 'a2' }, { name: 'Main', state: 'missing', localId: 'a1' }, { name: 'Old', state: 'loggedOut', localId: null }];
  it('選んだ名前、無ければこの PC のいまのアカウントと同じ名前、それも無ければ選べる最初。選べない名前も黙って移さない', () => {
    expect(peerAccountPick(rows, 'Work', 'Main')).toBe('Work');
    expect(peerAccountPick(rows, null, 'Main')).toBe('Main');
    expect(peerAccountPick(rows, null, 'Old')).toBe('Old');
    expect(peerAccountPick(rows, null, 'Gone')).toBe('Work');
    expect(peerAccountPick(rows, null, null)).toBe('Work');
  });
  it('名前が一覧に無く、選べるものも無ければ null（相手の既定に任せる）', () => {
    expect(peerAccountPick([{ name: 'Old', state: 'loggedOut', localId: null }], null, null)).toBeNull();
    expect(peerAccountPick([], null, 'Main')).toBeNull();
  });
});
