import { describe, expect, it } from 'vitest';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { markOrchestrator } from './orchestratorRole.ts';

const live = (sessionId: string, over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId, status: 'idle', name: null, nameSource: null, cwd: '/w', pid: 1, ...over });

describe('markOrchestrator', () => {
  it('設定の会話の登録（provider の id で引く）にだけ role を付け、ほかは同じ物のまま返す', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'sessions', { id: 'h1', provider: 'claude-code', provider_session_id: 'uuid-1', cwd: '/w', home_device: 'd' }, 'd');
    const a = live('uuid-1');
    const b = live('uuid-2');
    const out = markOrchestrator(db, () => 'h1')([a, b]);
    expect(out[0]).toEqual({ ...a, role: 'orchestrator' });
    expect(out[1]).toBe(b);
    expect('role' in a).toBe(false);
  });
  it('設定が空、会話が消えた、別のエージェントの同じ id には付けない。付ける物が無ければ同じ配列を返す', () => {
    const db = openDb(':memory:');
    upsertShared(db, 'sessions', { id: 'h1', provider: 'claude-code', provider_session_id: 'uuid-1', cwd: '/w', home_device: 'd' }, 'd');
    const list = [live('uuid-1')];
    expect(markOrchestrator(db, () => null)(list)).toBe(list);
    expect(markOrchestrator(db, () => 'gone')(list)).toBe(list);
    const codex = [live('uuid-1', { agent: 'codex' })];
    expect(markOrchestrator(db, () => 'h1')(codex)).toBe(codex);
  });
});
