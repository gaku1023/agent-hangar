import { describe, expect, it } from 'vitest';
import type { OpencodeEventListener } from '../provider/opencode/live.ts';
import { OPENCODE_TURN_ENDED, uploadOnOpencodeTurnEnd } from './opencodeTurnEnd.ts';

/** serve の出来事の口の偽物。 */
const eventsHub = () => {
  const listeners = new Set<OpencodeEventListener>();
  return {
    on: (cb: OpencodeEventListener) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    emit: (id: string, type: string) => { for (const cb of listeners) cb(id, type); },
    size: () => listeners.size,
  };
};

describe('opencode のターンの終わりで本文を上げる契機', () => {
  it('作業の終わり（成功、失敗、中断）だけを、会話の ID で上げる側へ渡す', () => {
    const hub = eventsHub();
    const noted: string[] = [];
    uploadOnOpencodeTurnEnd(hub.on, () => ({ noteOpencode: (id) => { noted.push(id); } }));
    for (const t of ['server.connected', 'session.execution.started', 'session.step.ended', 'session.text.ended', 'session.usage.updated', 'permission.asked']) hub.emit('ses_a', t);
    expect(noted).toEqual([]);
    hub.emit('ses_a', 'session.execution.succeeded');
    hub.emit('ses_b', 'session.execution.failed');
    hub.emit('ses_a', 'session.execution.interrupted');
    expect(noted).toEqual(['ses_a', 'ses_b', 'ses_a']);
    expect([...OPENCODE_TURN_ENDED].sort()).toEqual(['session.execution.failed', 'session.execution.interrupted', 'session.execution.succeeded']);
  });

  it('同期を設定していない（上げる側が無い）間は何もしない。上げる側はその都度引く', () => {
    const hub = eventsHub();
    const noted: string[] = [];
    let uploader: { noteOpencode(id: string): void } | null = null;
    const off = uploadOnOpencodeTurnEnd(hub.on, () => uploader);
    hub.emit('ses_a', 'session.execution.succeeded');
    uploader = { noteOpencode: (id) => { noted.push(id); } };
    hub.emit('ses_a', 'session.execution.succeeded');
    expect(noted).toEqual(['ses_a']);
    off();
    expect(hub.size()).toBe(0);
  });
});
