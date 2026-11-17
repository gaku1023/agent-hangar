import { isQuietStatus, notifyRulesOf, orchestratorOf, type LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { getSession } from '../db/queries.ts';
import { INTENT_MAX } from './intents.ts';
import { turnRunning } from './unreadHold.ts';
import { addUnread, onNotifyCall } from './unread.ts';

/**
 * notify_user の出し忘れの受け皿（2026-11-18）。
 *
 * 起動時の指示は、返答を書いたら notify_user で知らせるよう頼むが、エージェントは出し忘れる。
 * 特に、裏で走らせた作業が終わって始まるターンでは忘れやすく、利用者には何も届かない。
 * そこで、作業中からターンを抜けた会話のうち、そのターンに notify_user が一度も呼ばれなかったものに、最後の返答の頭の 1 文で未読を 1 つ積む。
 *
 * 出すのは未読の数だけで、OS の通知とスマホの通知は出さない。
 * エージェントが自分で知らせると決めたものではないので、利用者の手を止める通知にはしない。
 * 知らせ方の決まりで未読に done を含まないとき、notify_user の段を切ったとき、休みの会話、統括の会話には積まない。
 *
 * ターンを抜けたとみなすのは、入力待ち（idle）と、裏だけが動く（aside）に移ったときである（UnreadHold と同じ turnRunning で見る）。
 * 問いの入力待ち（AskUserQuestion）で終わったターンは、入力待ちの知らせが別に出るので積まない。run が居なくなったときも積まない。
 * 作業中と見る前に呼ばれた notify_user も落とさないよう、呼ばれた印はターンの始まりで消さず、終わりの判定で使い切る。
 * 返答の本文の索引は状態より少し遅れるので、ターンの始まり以後の返答が見えるまで間を置いて読み直し、上限まで見えなければ諦める。
 */

/** ターンの始まりを見た時刻より、これだけ前の返答までをそのターンのものとみなす。状態の読み取りは本文より遅れることがあるため。 */
export const START_SLACK_MS = 2000;
const POLL_MS = 1000;
const MAX_WAIT_MS = 10_000;

export type NotifyFallbackDeps = {
  db: Db;
  /** いまの実行中の一覧（agent/liveHub.ts の LiveHub.current）。 */
  live: () => LiveSessionDto[];
  /** いまの設定。知らせ方の決まり、notify_user の段の入切、統括の会話を読む。 */
  settings: () => Parameters<typeof notifyRulesOf>[0] & { notifyUser?: boolean; orchestrator?: unknown };
  /** 会話の最後の返答とその時刻（mcp/waitTool.ts の lastReply）。 */
  lastReply: (sessionId: string) => { text: string; ts: number | null } | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
  pollMs?: number;
  maxWaitMs?: number;
};

/** 返答の頭の 1 文。Markdown の飾りとコードの塊を外し、最初の行の最初の文で切る。INTENT_MAX を越えたら切って … を付ける。 */
export function firstSentence(text: string): string | null {
  const lines = text.replace(/```[\s\S]*?(```|$)/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    if (!line) continue;
    const m = /^.*?(?:[。！？]|[.!?](?=\s|$))/.exec(line);
    const s = (m ? m[0] : line).trim();
    const cs = [...s];
    return cs.length > INTENT_MAX ? `${cs.slice(0, INTENT_MAX - 1).join('')}…` : s;
  }
  return null;
}

export class NotifyFallback {
  /** 作業中と見ている会話（hangar の id）と、作業中と見た時刻。 */
  private running = new Map<string, number>();
  /** 最後の判定の後に notify_user が呼ばれた会話。 */
  private notified = new Set<string>();

  constructor(private readonly deps: NotifyFallbackDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** notify_user が呼ばれたことを聞き始める。戻り値を呼ぶと外す。 */
  start(): () => void {
    return onNotifyCall((id) => { this.notified.add(id); });
  }

  /** 登録が変わったときに呼ぶ。作業中に入った会話を覚え、抜けた会話を判定する。 */
  check(): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const l of this.deps.live()) {
      const id = this.sessionIdOf(l);
      if (!id) continue;
      seen.add(id);
      if (turnRunning(l)) {
        if (!this.running.has(id)) this.running.set(id, now);
        continue;
      }
      const started = this.running.get(id);
      if (started === undefined) continue;
      this.running.delete(id);
      const notified = this.notified.delete(id);
      if (notified || l.status === 'waiting') continue;
      this.attempt(id, started, now);
    }
    // run が居なくなった会話は、積まずに忘れる。
    for (const id of [...this.running.keys()]) {
      if (seen.has(id)) continue;
      this.running.delete(id);
      this.notified.delete(id);
    }
  }

  private sessionIdOf(l: LiveSessionDto): string | null {
    const r = this.deps.db.prepare('select id from sessions where provider = ? and provider_session_id = ?').get(l.agent ?? 'claude-code', l.sessionId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** そのターンの返答が見えたら未読を積む。まだ見えなければ、上限まで間を置いて読み直す。 */
  private attempt(id: string, started: number, endedAt: number): void {
    // 終わりの後に呼ばれた notify_user（裏の作業の間など）があれば、それに任せる。
    if (this.notified.has(id)) return;
    const reply = this.deps.lastReply(id);
    if (reply && reply.ts !== null && reply.ts >= started - START_SLACK_MS) {
      this.give(id, reply.text);
      return;
    }
    const poll = this.deps.pollMs ?? POLL_MS;
    if (this.now() + poll - endedAt > (this.deps.maxWaitMs ?? MAX_WAIT_MS)) return;
    const set = this.deps.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
    set(() => {
      try { this.attempt(id, started, endedAt); } catch (e) { console.error('[unread] fallback failed', e instanceof Error ? e.message : e); }
    }, poll);
  }

  private give(id: string, reply: string): void {
    const settings = this.deps.settings();
    if (settings.notifyUser === false) return;
    if (!notifyRulesOf(settings).unread.includes('done')) return;
    if (orchestratorOf(settings.orchestrator).sessionId === id) return;
    const session = getSession(this.deps.db, this.deps.live(), id);
    if (!session || (isQuietStatus(session.state?.status) && !session.woke)) return;
    const text = firstSentence(reply);
    if (!text) return;
    addUnread(this.deps.db, id, text, this.now());
    touchRow(this.deps.db, 'sessions', id);
  }
}
