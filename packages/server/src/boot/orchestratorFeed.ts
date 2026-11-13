import { orchestratorOf } from '@agent-hangar/shared';
import type { LiveHub } from '../agent/liveHub.ts';
import { getSession } from '../db/queries.ts';
import { translatorOf } from '../i18n/message.ts';
import { sanitizeInput } from '../mcp/screenTools.ts';
import { sessionTitleOf } from '../mobile/feed.ts';
import { feedText, OrchestratorFeed } from '../orchestrator/feed.ts';
import { forgetSend, involvedWith } from '../orchestrator/involved.ts';
import { noteFedTurn } from '../orchestrator/turnMark.ts';
import { inputEmptyFromCapture } from '../peer/chat/inputBox.ts';
import type { RunManager } from '../runs/manager.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import type { HomeParts } from './home.ts';
import { panesOf, type RunsParts } from './runs.ts';

export type OrchestratorFeedParts = {
  feed: OrchestratorFeed;
  /** 実行中の一覧の変化を聞き始める。 */
  start(): void;
  stop(): void;
};

/**
 * 統括への出来事の送り込み（orchestrator/feed.ts）を、この PC の DB、実行中の一覧、統括の画面につなぐ。
 * 許可待ちの通知の猶予は、OS の通知の見張り（boot/runs.ts）へここで差し込み、スマホの通知（boot/mobile.ts）へは呼び手が held を渡す。
 * 猶予が明けたときは onGraceEnd を呼ぶ（呼び手がスマホの書き手を急がせる）。OS の通知の見張りは、預かっている間は短い周期で見ているので自分で拾う。
 */
export function bootOrchestratorFeed(p: {
  home: Pick<HomeParts, 'db' | 'device' | 'settings' | 'language'>;
  delivery: { live: Pick<LiveHub, 'current' | 'onChange'> };
  runs: Pick<RunsParts, 'mux' | 'setNoticeHold'> & { runs: Pick<RunManager, 'sendInput'> };
  onGraceEnd?: (sessionId: string) => void;
}): OrchestratorFeedParts {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const idOf = db.prepare('select id from sessions where provider = ? and provider_session_id = ? and deleted_at is null');
  const tr = translatorOf(p.home.language);
  /** 統括の画面。この PC で生きている run が無ければ null。 */
  const paneOf = (sessionId: string) => {
    const run = aliveRunForSession(db, sessionId, deviceId, Date.now());
    const panes = panesOf(p.runs.mux());
    if (!run || run.deviceId !== deviceId || !panes?.captureStyled) return null;
    const captureStyled = panes.captureStyled.bind(panes);
    return { tmuxName: run.tmuxName, empty: async () => { const cap = await captureStyled(run.tmuxName); return cap != null && inputEmptyFromCapture(cap); } };
  };

  const feed = new OrchestratorFeed({
    orchestrator: () => orchestratorOf(p.home.settings.current.orchestrator),
    live: () => p.delivery.live.current(),
    resolve: (l) => {
      const r = idOf.get(l.agent ?? 'claude-code', l.sessionId) as { id: string } | undefined;
      return r ? { id: r.id, title: sessionTitleOf(db, r.id) ?? '' } : null;
    },
    involved: (self, id) => involvedWith(db, deviceId, self, id),
    reported: (self, id) => { forgetSend(db, self, id); },
    inputEmpty: async (id) => (await paneOf(id)?.empty()) === true,
    // 貼る直前にもう一度、入力欄が空であることを確かめる（利用者が打ち始めたら渡さず、預かりに戻す）。
    deliver: async (id, text) => {
      const pane = paneOf(id);
      if (!pane || !(await pane.empty())) return false;
      await p.runs.runs.sendInput(pane.tmuxName, sanitizeInput(text), true);
      return true;
    },
    format: (lines) => feedText(tr, lines),
    onFed: (id) => { noteFedTurn(db, id); },
    contextTokens: (id) => getSession(db, p.delivery.live.current(), id, { deviceId, now: Date.now })?.stats.contextTokens ?? null,
    ...(p.onGraceEnd ? { onGraceEnd: p.onGraceEnd } : {}),
  });
  p.runs.setNoticeHold((id) => feed.held(id));

  let off: (() => void) | null = null;
  return {
    feed,
    start() {
      off ??= p.delivery.live.onChange(() => { feed.onLiveChange(); });
      feed.onLiveChange();
    },
    stop() {
      off?.();
      off = null;
      feed.stop();
    },
  };
}
