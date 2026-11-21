import type { NotifyKind } from '@agent-hangar/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { addUnread, bindUnreadDevice, onUnreadReady, type NotifyTarget } from './unread.ts';
import { noticeArrivedUnread, type ArriveDeps } from './unreadArrive.ts';
import { noteViewing, resetViewing } from './viewing.ts';

/**
 * ほかの PC から届いた未読の OS の通知（2026-11-21）。
 * 受け取った PC も、自分の知らせ方の決まり（os の列）どおりに出す。スマホへは出さない（動かしている PC だけが出す）。
 * 設定 sidebarOtherPcs が切なら、ほかの PC の会話の未読は鳴らさない。
 */

type Db = ReturnType<typeof openDb>;

function world(o: { kind?: NotifyKind; device?: string } = {}): Db {
  const db = openDb(':memory:');
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'w' }, 'w');
  bindUnreadDevice(db, o.device ?? 'w');
  addUnread(db, 's1', '終わりました', 10, { kind: o.kind ?? 'done' });
  return db;
}

const fired: { id: string; text: string; count: number; sent: NotifyTarget[]; kind: NotifyKind }[] = [];
const off = onUnreadReady((id, text, count, sent, meta) => { fired.push({ id, text, count, sent, kind: meta.kind }); });
afterEach(() => { fired.splice(0); });
afterAll(() => off());

const deps = (db: Db, o: Partial<ArriveDeps> = {}): ArriveDeps => ({ db, deviceId: 'm', settings: () => ({}), session: () => ({ role: null, quiet: false }), ...o });

describe('noticeArrivedUnread', () => {
  it('決まりの os に場面が入っていれば、os だけを出し先にして onUnreadReady へ流す', () => {
    const db = world();
    noticeArrivedUnread(deps(db), 's1');
    expect(fired).toEqual([{ id: 's1', text: '終わりました', count: 1, sent: ['os'], kind: 'done' }]);
  });
  it('この PC で開いて見ている会話には出さない（相手がまだこちらの見ているのを知らずに積んだ分）', () => {
    const db = world();
    noteViewing('win', 's1');
    try {
      noticeArrivedUnread(deps(db), 's1');
      expect(fired).toEqual([]);
    } finally {
      resetViewing();
    }
  });
  it('決まりの os に場面が無ければ出さない', () => {
    const db = world({ kind: 'progress' });
    noticeArrivedUnread(deps(db), 's1');
    expect(fired).toEqual([]);
  });
  it('設定 sidebarOtherPcs が切なら出さない', () => {
    const db = world();
    noticeArrivedUnread(deps(db, { settings: () => ({ sidebarOtherPcs: false }) }), 's1');
    expect(fired).toEqual([]);
  });
  it('この PC が積んだ未読、統括の会話、静かにした会話には出さない', () => {
    noticeArrivedUnread(deps(world({ device: 'm' })), 's1');
    noticeArrivedUnread(deps(world(), { session: () => ({ role: 'orchestrator', quiet: false }) }), 's1');
    noticeArrivedUnread(deps(world(), { session: () => ({ role: null, quiet: true }) }), 's1');
    noticeArrivedUnread(deps(world(), { session: () => null }), 's1');
    expect(fired).toEqual([]);
  });
});
