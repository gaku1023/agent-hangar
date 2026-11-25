import type { Db } from '../db/open.ts';
import type { PtySpawn } from '../pty/relay.ts';
import { createAddressBook } from '../remote/addresses.ts';
import { RemoteShellService, type RemoteShellEvent } from '../remote/service.ts';

/**
 * SSH のシェルタブの部品を組む（docs/design.md「SSH のシェルタブ」）。
 * 前回つながった住所の覚え（addressBook）は PC 共通で 1 つだけ持ち、どのタブの link も同じものを引く。
 * 経路（routes/remoteShell.ts）と端末の中継（PtyRelay の remote）が、ここで作ったサービスを共有する。
 */
export function bootRemoteShell(p: { db: Db; selfId: string; spawn: PtySpawn; broadcast(ev: RemoteShellEvent): void }): RemoteShellService {
  return new RemoteShellService({
    db: p.db,
    selfId: p.selfId,
    broadcast: p.broadcast,
    linkDeps: { db: p.db, spawn: p.spawn, addressBook: createAddressBook() },
  });
}
