import { orchestratorLineage, orchestratorOf } from '@agent-hangar/shared';
import type { LiveHub } from '../agent/liveHub.ts';
import { getSession } from '../db/queries.ts';
import { translatorOf } from '../i18n/message.ts';
import { sanitizeInput } from '../mcp/screenTools.ts';
import { sessionTitleOf } from '../mobile/feed.ts';
import { onNotifyKind } from '../live/notifyKind.ts';
import { feedText, OrchestratorFeed } from '../orchestrator/feed.ts';
import { lineageInvolvement } from '../orchestrator/involved.ts';
import { noteFedTurn } from '../orchestrator/turnMark.ts';
import { inputEmptyFor } from '../peer/chat/inputBox.ts';
import type { RunManager } from '../runs/manager.ts';
import { aliveRunForSession } from '../runs/queries.ts';
import type { HomeParts } from './home.ts';
import { panesOf, type RunsParts } from './runs.ts';

export type OrchestratorFeedParts = {
  feed: OrchestratorFeed;
  /** 統括の入力欄が空か（画面を取り込んで見る）。run が無ければ偽。 */
  inputEmpty(sessionId: string): Promise<boolean>;
  /** `[hangar]` の文を統括へ渡し、出来事のターンと印を残す（切り替えの申し送りの頼みと引き継ぎ）。入力欄が空でなければ渡さず偽。 */
  sendEvent(sessionId: string, text: string): Promise<boolean>;
  /** 引き継ぎに載せる事実：統括の系譜が起こした・送った会話のうち動いているものと、預かり中の問い。 */
  handoffFacts(): { active: { id: string; title: string }[]; asks: { kind: string; id: string; title: string }[] };
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
  /** 質問を待つ会話の、いま画面に出ている札の id（peer chat の宿主の local.currentAsk）。 */
  askId?: (sessionId: string) => string | null;
}): OrchestratorFeedParts {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const idOf = db.prepare('select id from sessions where provider = ? and provider_session_id = ? and deleted_at is null');
  const providerOf = db.prepare('select provider from sessions where id = ?');
  const tr = translatorOf(p.home.language);
  /**
   * 統括の画面。この PC で生きている run が無ければ null。
   * 入力欄の空の判定は、統括のエージェント（Claude Code の ❯ の箱、Codex の › の行）で選ぶ。
   */
  const paneOf = (sessionId: string) => {
    const run = aliveRunForSession(db, sessionId, deviceId, Date.now());
    const panes = panesOf(p.runs.mux());
    if (!run || run.deviceId !== deviceId || !panes?.captureStyled) return null;
    const captureStyled = panes.captureStyled.bind(panes);
    const agent = (providerOf.get(sessionId) as { provider: string } | undefined)?.provider ?? 'claude-code';
    return { tmuxName: run.tmuxName, empty: async () => { const cap = await captureStyled(run.tmuxName); return cap != null && inputEmptyFor(agent, cap); } };
  };

  const lineage = lineageInvolvement(db, deviceId, () => orchestratorOf(p.home.settings.current.orchestrator));
  const feed = new OrchestratorFeed({
    orchestrator: () => orchestratorOf(p.home.settings.current.orchestrator),
    live: () => p.delivery.live.current(),
    resolve: (l) => {
      const r = idOf.get(l.agent ?? 'claude-code', l.sessionId) as { id: string } | undefined;
      return r ? { id: r.id, title: sessionTitleOf(db, r.id) ?? '' } : null;
    },
    // 前の統括（系譜）が起こした会話と送った会話も、今の統括に届ける。
    involved: lineage.involved,
    reported: lineage.reported,
    inputEmpty: async (id) => (await paneOf(id)?.empty()) === true,
    // 貼る直前にもう一度、入力欄が空であることを確かめる（利用者が打ち始めたら渡さず、預かりに戻す）。
    deliver: (id, text) => deliver(id, text),
    format: (lines) => feedText(tr, lines),
    onFed: (id) => { noteFedTurn(db, id); },
    contextTokens: (id) => getSession(db, p.delivery.live.current(), id, { deviceId, now: Date.now })?.stats.contextTokens ?? null,
    ...(p.onGraceEnd ? { onGraceEnd: p.onGraceEnd } : {}),
    ...(p.askId ? { askId: p.askId } : {}),
  });
  p.runs.setNoticeHold((id) => feed.held(id));

  let off: (() => void) | null = null;
  let offNotify: (() => void) | null = null;
  const deliver = async (id: string, text: string): Promise<boolean> => {
    const pane = paneOf(id);
    if (!pane || !(await pane.empty())) return false;
    await p.runs.runs.sendInput(pane.tmuxName, sanitizeInput(text), true);
    return true;
  };
  return {
    feed,
    inputEmpty: async (id) => (await paneOf(id)?.empty()) === true,
    async sendEvent(id, text) {
      // 渡せたら印を残す（出来事の送り込みの onFed と同じ）。索引が [hangar] の文を読む前から、出来事のターンとして扱う（orchestrator/turnMark.ts）。
      const ok = await deliver(id, text);
      if (ok) noteFedTurn(db, id);
      return ok;
    },
    handoffFacts() {
      const o = orchestratorOf(p.home.settings.current.orchestrator);
      const selves = orchestratorLineage(o);
      const active: { id: string; title: string }[] = [];
      for (const l of p.delivery.live.current()) {
        const r = idOf.get(l.agent ?? 'claude-code', l.sessionId) as { id: string } | undefined;
        if (!r || selves.includes(r.id) || !lineage.involved(o.sessionId ?? '', r.id)) continue;
        active.push({ id: r.id, title: sessionTitleOf(db, r.id) ?? '' });
      }
      const asks = feed.pending().filter((x) => x.kind === 'ask.permission' || x.kind === 'ask.question').map((x) => ({ kind: x.kind, id: x.sessionId, title: x.title }));
      return { active, asks };
    },
    start() {
      off ??= p.delivery.live.onChange(() => { feed.onLiveChange(); });
      // turn.done は、そのターンに notify_user が done か ask で呼ばれた会話だけ。
      offNotify ??= onNotifyKind((id, kind, immediate) => { feed.noteNotify(id, kind, immediate); });
      feed.onLiveChange();
    },
    stop() {
      off?.();
      off = null;
      offNotify?.();
      offNotify = null;
      feed.stop();
    },
  };
}
