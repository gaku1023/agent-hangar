import { describe, expect, it } from 'vitest';
import { translator, type SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { emptySlice } from '../store/peerChat.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { presentPeerChat } from './peerChat.ts';
import { presentSession } from './session.ts';
import { presentShell } from './shell.ts';

// 会話ごとの context の量（輪と label）を、サイドバーの行、会話の画面、別 PC の会話の枠へ渡す。

const NOW = Date.parse('2026-11-25T12:00:00Z');
const base = { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null };
const session = (over: Partial<SessionDto> = {}, stats: Record<string, unknown> = {}): SessionDto => sessionDto({ id: 's1', name: 'n', cwd: '/w', hasTranscript: true, lastActivityAt: NOW - 1000, live: 'busy', stats: { ...base, ...stats }, ...over });
const storeOf = (list: SessionDto[]): Store => { const s = initialStore(); s.bootstrapped = true; s.sessions = Object.fromEntries(list.map((x) => [x.id, x])); return s; };
const rowsOf = (st: Store) => presentShell(initialState(), st, NOW).live.rows;
const lock = { deviceId: 'd2', deviceName: 'Office', runId: 'r9', heartbeatAt: NOW - 1000, stale: false };

describe('サイドバーの行の ctx', () => {
  it('量のある行は輪の材料を持ち、量の無い行は持たない', () => {
    const st = storeOf([session({ id: 'a' }, { contextTokens: 448_000, contextSize: 1_000_000 }), session({ id: 'b' }, { contextTokens: null })]);
    const rows = rowsOf(st);
    expect(rows.find((r) => r.id === 'a')!.ctx).toMatchObject({ level: 'alert', label: '448K/1000K' });
    expect(rows.find((r) => r.id === 'b')!.ctx ?? null).toBeNull();
  });
  it('別 PC の行も同じに持つ。設定の境目に従う', () => {
    const st = storeOf([session({ id: 'c', live: null, lock }, { contextTokens: 151_000, contextSize: 200_000 })]);
    st.settings = { contextWarnTokens: 100_000, contextAlertTokens: 160_000 } as never;
    expect(rowsOf(st)[0]!.ctx).toMatchObject({ level: 'warn', label: '151K/200K' });
  });
});

describe('会話の画面と別 PC の枠の ctx', () => {
  const present = (st: Store) => presentSession(initialState(), st, NOW, 's1');
  it('会話の画面は ctx を持つ', () => {
    expect(present(storeOf([session({}, { contextTokens: 286_000, contextSize: 1_000_000 })])).ctx).toMatchObject({ level: 'none', label: '286K/1000K' });
    expect(present(storeOf([session()])).ctx ?? null).toBeNull();
  });
  it('別 PC の会話の枠（PeerChatView）も ctx を持つ', () => {
    const st = storeOf([session({ lock }, { contextTokens: 151_000, contextSize: 200_000 })]);
    st.device = { id: 'me', name: 'Win' };
    st.peerChat = { s1: { ...emptySlice('v1'), phase: 'live', device: { deviceId: 'd2', deviceName: 'Office' }, status: 'busy' } };
    expect(presentPeerChat(st, 's1', translator('ja'))!.ctx).toMatchObject({ label: '151K/200K' });
  });
});
