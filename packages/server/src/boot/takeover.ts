import path from 'node:path';
import type { RunManager } from '../runs/manager.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import { TakeoverService } from '../sync/takeover.ts';
import { TakeoverResponder } from '../sync/takeoverResponder.ts';
import { cancelOrphanAsks, pruneTakeoverRows } from '../sync/takeoverRows.ts';
import type { HomeParts } from './home.ts';
import type { OpencodeParts } from './opencode.ts';
import type { SyncParts } from './sync.ts';

export type TakeoverParts = {
  /** ほかの PC から頼まれた「この会話を止めてほしい」を扱う。 */
  responder: TakeoverResponder;
  /** 「この PC で再開」の頼む側。ほかの PC で動く会話を止めてもらい、最後の本文が降りるのを待つ。 */
  service: TakeoverService;
  /** 古い自分の行を刈り、再起動の前に出したまま答えの無い ask を取り下げ、起動前に届いていた頼みを 1 度扱い、以後は頼みの行が届くたびに扱う。 */
  start(): void;
  stop(): void;
  /** 止める前に端末へ 1 行を残す口を渡す。端末の中継（PtyRelay）は待ち受けの後に作られるので、後から差す。 */
  setNotePane(fn: (tmuxName: string, text: string) => void): void;
};

/**
 * 引き継ぎの頼みの受け手（sync/takeoverResponder.ts）と、頼む側（sync/takeover.ts）を組む。
 * start で 1 度 scan するのは、Hangar が止まっていた間に届いた頼みと、再起動後も tmux に残っている奪われた claude のためである。
 * 同期より後に始める（頼みの行は pull で届くので、始める前に受け手の口が要る）。
 */
export function bootTakeover(p: {
  home: Pick<HomeParts, 'db' | 'language'> & { device: Pick<HomeParts['device'], 'id' | 'name'> };
  runs: { runs: Pick<RunManager, 'getRun' | 'kill'> };
  sync: Pick<SyncParts, 'flushSession' | 'pushNow' | 'onTakeoversApplied' | 'pullForTakeover' | 'canCarryTakeover'>;
  delivery: { hub: { broadcast(ev: NoticeEvent): void } };
  againMs?: number;
  /** opencode の serve の管理（boot/opencode.ts）。引き継ぎの受け手より後に組むので、呼ばれた時点で引く。無ければ opencode の会話も Claude と同じ順で止める。 */
  opencode?: () => Pick<OpencodeParts, 'transfer' | 'exporter'> | null;
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
    // opencode の会話は、interrupt して idle を待ち、書き出して上げてから止める。
    opencode: {
      quiesce: async (sessionId, providerSessionId) => p.opencode?.()?.transfer.quiesce(sessionId, providerSessionId),
      // 書き出しの置き場がまだ無ければ（serve の管理を組む前）、空の名前を返して台帳の版で答えさせる。
      exportFile: (providerSessionId) => { const ex = p.opencode?.()?.exporter; return ex ? path.join(ex.dir, `${providerSessionId}.json`) : ''; },
    },
  });
  const service = new TakeoverService({
    db, deviceId,
    canCarry: () => p.sync.canCarryTakeover(),
    pushNow: p.sync.pushNow,
    pull: p.sync.pullForTakeover,
    broadcast: (takeover) => { p.delivery.hub.broadcast({ type: 'takeover.update', takeover }); },
  });
  const run = (): void => {
    // 応答や本文の行が届いたら、頼んで待っている会話も確かめ直す。
    service.noteApplied();
    void responder.scan().catch((e: unknown) => console.error('[takeover]', e instanceof Error ? e.message : e));
  };
  let off: (() => void) | null = null;
  return {
    responder,
    service,
    start() {
      try { pruneTakeoverRows(db, deviceId, Date.now()); } catch (e) { console.error('[takeover] 古い行を刈れませんでした', e instanceof Error ? e.message : e); }
      // 待つ状態はメモリにしか無く、再起動で消える。残った ask が生きていると、利用者が諦めた後で相手が claude を停止する。
      // だから、この PC が出したまま答えの無い ask は取り下げて送る。force は相手の次の起動で止める約束なので残す。
      try {
        // ログはサーバの直書きの日本語を増やさないよう英語にする（i18n/hardcoded.test.ts）。
        if (cancelOrphanAsks(db, deviceId, Date.now()) > 0) void p.sync.pushNow().catch((e: unknown) => console.error('[takeover] could not push the cancelled asks yet', e instanceof Error ? e.message : e));
      } catch (e) { console.error('[takeover] could not cancel the asks left from before the restart', e instanceof Error ? e.message : e); }
      off ??= p.sync.onTakeoversApplied(run);
      run();
    },
    stop() {
      off?.();
      off = null;
      service.stop();
    },
    setNotePane(fn) { notePane = fn; },
  };
}
