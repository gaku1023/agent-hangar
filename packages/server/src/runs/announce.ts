import type { RunDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import type { RunListener } from './manager.ts';
import { aliveRunForSession } from './queries.ts';

/**
 * run の出来事を画面へ配る受け手を作る。RunManager.on に渡す。
 * run が終わったときは事後要約の契機になる。受け付けの可否は SummaryJob が決めるので、ここは頼むだけである。
 */
export function runAnnouncer(o: { db: Db; hub: { broadcast(ev: NoticeEvent): void }; onEnded: (run: RunDto) => void }): Required<RunListener> {
  return {
    runStarted: (r) => {
      o.hub.broadcast({ type: 'run.started', run: r.run, tabs: r.tabs });
      // run が付いたセッションは、行は変わらなくても中身が変わる。run.started の後に届くよう、ここで名指しする。
      touchRow(o.db, 'sessions', r.sessionId);
    },
    runUpdated: (run) => o.hub.broadcast({ type: 'run.upsert', run }),
    runEnded: (run) => { o.hub.broadcast({ type: 'run.ended', run }); o.onEnded(run); },
    tabChanged: (tab) => o.hub.broadcast({ type: 'tab.upsert', tab }),
  };
}

/**
 * そのセッションがいま動いているか。
 * hangar の run だけでなく、hangar の外で動いている Claude も「実行中」と見なす。
 */
export function sessionRunsAnywhere(o: { db: Db; live: () => readonly { sessionId: string }[] }, sessionId: string): boolean {
  if (aliveRunForSession(o.db, sessionId) !== null) return true;
  const s = o.db.prepare('select provider_session_id p from sessions where id = ?').get(sessionId) as { p: string } | undefined;
  return !!s && o.live().some((l) => l.sessionId === s.p);
}
