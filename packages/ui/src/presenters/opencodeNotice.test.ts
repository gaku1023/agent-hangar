import { describe, expect, it } from 'vitest';
import type { OpencodeStatusDto, RunDto, SessionDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentOpencodeVersionCard } from './opencodeNotice.ts';
import { presentSession } from './session.ts';
import { presentToasts } from './toasts.ts';

const storeOf = (status: OpencodeStatusDto | null, enabled = true): Store => ({
  ...initialStore(),
  settings: { ...(initialStore().settings ?? {}), opencodeEnabled: enabled } as SettingsDto,
  opencodeStatus: status,
});
const found = (version: string | null, verified = false): OpencodeStatusDto => ({ found: true, version, verified });

describe('未検証の版の札（C7、試作の N1）', () => {
  it('範囲の外の版なら、見出し・題・本文・操作をそろえて出す', () => {
    expect(presentOpencodeVersionCard(initialState(), storeOf(found('2.2.0')))).toEqual({
      version: '2.2.0',
      head: '未検証のバージョン',
      who: 'opencode 2.2.0',
      title: 'opencode 2.2.0 は未検証のバージョンです',
      body: '検証済み：2.1.x。API の変更により、状態や権限確認が正しく表示されない可能性があります。',
      settings: '設定を開く',
      proceed: 'このまま続行',
    });
  });
  it('1.x は、題は同じにして、本文で対応していないことを言う（設定の版の行と同じ文）', () => {
    const c = presentOpencodeVersionCard(initialState(), storeOf(found('1.4.0')));
    expect(c?.title).toBe('opencode 1.4.0 は未検証のバージョンです');
    expect(c?.body).toBe('opencode 1.x には対応していません。2.x に更新してください。');
  });
  it('同じ版では二度出さない。版が変われば、また出す', () => {
    const seen: State = { ...initialState(), opencodeVersionSeen: '2.2.0' };
    expect(presentOpencodeVersionCard(seen, storeOf(found('2.2.0')))).toBeNull();
    expect(presentOpencodeVersionCard(seen, storeOf(found('2.3.1')))?.version).toBe('2.3.1');
  });
  it('設定の opencode が切なら出さない', () => {
    expect(presentOpencodeVersionCard(initialState(), storeOf(found('2.2.0'), false))).toBeNull();
    expect(presentOpencodeVersionCard(initialState(), { ...initialStore(), opencodeStatus: found('2.2.0') })).toBeNull();
  });
  it('確かめた範囲の版、版が読めないとき、見つからないとき、答えが届く前は出さない', () => {
    for (const s of [found('2.1.4', true), found(null), { found: false, version: null, verified: false }, null]) {
      expect(presentOpencodeVersionCard(initialState(), storeOf(s)), JSON.stringify(s)).toBeNull();
    }
  });
  it('設定の連携の節を開いている間は、そこの版の行が同じことを言うので出さない', () => {
    const at: State = { ...initialState(), screen: { name: 'settings', at: 'opencode' } };
    expect(presentOpencodeVersionCard(at, storeOf(found('2.2.0')))).toBeNull();
    const other: State = { ...initialState(), screen: { name: 'settings', at: 'about' } };
    expect(presentOpencodeVersionCard(other, storeOf(found('2.2.0')))).not.toBeNull();
  });
  it('右下の知らせに載る', () => {
    expect(presentToasts(initialState(), storeOf(found('2.2.0')), 0).opencodeVersion?.version).toBe('2.2.0');
    expect(presentToasts(initialState(), storeOf(found('2.1.4', true)), 0).opencodeVersion).toBeNull();
  });
});

const NOW = Date.parse('2026-10-25T12:00:00Z');
const session = (over: Partial<SessionDto> = {}): SessionDto => ({ id: 's1', provider: 'opencode', providerSessionId: 'ses_1', projectId: null, name: 'oc', cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, ...over });
const sessionStore = (s: SessionDto, runs: Record<string, RunDto> = {}): Store => ({ ...initialStore(), bootstrapped: true, sessions: { [s.id]: s }, runs });

describe('終わった opencode の会話の 1 行（C7、試作の E1）', () => {
  it('opencode の終わった会話にだけ付ける', () => {
    expect(presentSession(initialState(), sessionStore(session()), NOW, 's1').endedLine).toBe('opencode');
    expect(presentSession(initialState(), sessionStore(session({ provider: 'claude-code' })), NOW, 's1').endedLine).toBeNull();
  });
  it('動いている間と、再開できない会話（ほかの PC にだけある、本文が無い）には付けない', () => {
    expect(presentSession(initialState(), sessionStore(session({ live: 'busy' })), NOW, 's1').endedLine).toBeNull();
    const alive: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: NOW - 60_000, endedAt: null, endReason: null, heartbeatAt: 1 };
    expect(presentSession(initialState(), sessionStore(session(), { r1: alive }), NOW, 's1').endedLine).toBeNull();
    expect(presentSession(initialState(), sessionStore(session({ remoteOnly: true })), NOW, 's1').endedLine).toBeNull();
    expect(presentSession(initialState(), sessionStore(session({ hasTranscript: false })), NOW, 's1').endedLine).toBeNull();
  });
});
