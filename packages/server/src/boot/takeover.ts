import type { RunManager } from '../runs/manager.ts';
import { TakeoverResponder } from '../sync/takeoverResponder.ts';
import { pruneTakeoverRows } from '../sync/takeoverRows.ts';
import type { HomeParts } from './home.ts';
import type { SyncParts } from './sync.ts';

export type TakeoverParts = {
  /** ほかの PC から頼まれた「この会話を止めてほしい」を扱う。 */
  responder: TakeoverResponder;
  /** 古い自分の行を刈り、起動前に届いていた頼みを 1 度扱い、以後は頼みの行が届くたびに扱う。 */
  start(): void;
  stop(): void;
  /** 止める前に端末へ 1 行を残す口を渡す。端末の中継（PtyRelay）は待ち受けの後に作られるので、後から差す。 */
  setNotePane(fn: (tmuxName: string, text: string) => void): void;
};

/**
 * 引き継ぎの頼みの受け手（sync/takeoverResponder.ts）を組む。
 * start で 1 度 scan するのは、Hangar が止まっていた間に届いた頼みと、再起動後も tmux に残っている奪われた claude のためである。
 * 同期より後に始める（頼みの行は pull で届くので、始める前に受け手の口が要る）。
 */
export function bootTakeover(p: {
  home: Pick<HomeParts, 'db' | 'language'> & { device: Pick<HomeParts['device'], 'id' | 'name'> };
  runs: { runs: Pick<RunManager, 'getRun' | 'kill'> };
  sync: Pick<SyncParts, 'flushSession' | 'pushNow' | 'onTakeoversApplied'>;
  againMs?: number;
}): TakeoverParts {
  const { db, language } = p.home;
  const deviceId = p.home.device.id;
  let notePane: ((tmuxName: string, text: string) => void) | null = null;
  const nameOf = db.prepare('select name from devices where id = ?');
  const responder = new TakeoverResponder({
    db, deviceId, runs: p.runs.runs,
    flushSession: p.sync.flushSession,
    pushNow: p.sync.pushNow,
    notePane: (n, t) => { notePane?.(n, t); },
    deviceName: (id) => (nameOf.get(id) as { name: string } | undefined)?.name ?? id,
    language,
    ...(p.againMs !== undefined ? { againMs: p.againMs } : {}),
  });
  const run = (): void => { void responder.scan().catch((e: unknown) => console.error('[takeover]', e instanceof Error ? e.message : e)); };
  let off: (() => void) | null = null;
  return {
    responder,
    start() {
      try { pruneTakeoverRows(db, deviceId, Date.now()); } catch (e) { console.error('[takeover] 古い行を刈れませんでした', e instanceof Error ? e.message : e); }
      off ??= p.sync.onTakeoversApplied(run);
      run();
    },
    stop() {
      off?.();
      off = null;
    },
    setNotePane(fn) { notePane = fn; },
  };
}
