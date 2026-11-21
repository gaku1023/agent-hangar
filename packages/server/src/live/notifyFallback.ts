import { isQuietStatus, notifyRulesOf, orchestratorOf, type LiveSessionDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import { getSession } from '../db/queries.ts';
import { INTENT_MAX } from './intents.ts';
import { onNotifyKind } from './notifyKind.ts';
import { turnRunning } from './unreadHold.ts';
import { addUnread, noteUnreadReady, type NotifyTarget } from './unread.ts';
import { isViewing } from './viewing.ts';

/**
 * 返答の終わりで hangar が未読を 1 つ積む（2026-11-18 に出し忘れの受け皿として入れ、2026-11-21 に数え方の本体にした）。
 *
 * 未読の数は、エージェントが notify_user を呼ぶかどうかに頼らず、hangar が返答の終わりごとに 1 つ積む。Claude Code・Codex・opencode で同じである。
 * notify_user は、丸に 1 文と場面を添える役である。そのターンに done か ask で呼ばれていれば、その呼び出しが 1 つを積む（live/unreadHold.ts）ので、ここでは積まない（二重に数えない）。
 * progress の呼び出しは途中の 1 つとして別に積まれ、終わりの 1 つは打ち消さない。hangar が代わりに出した知らせ（immediate：承認待ち、起動の失敗）も打ち消さない。
 *
 * notify_user の無いターンは、最後の返答の頭の 1 文を未読の文にし、知らせ方の done の決まりどおり OS とスマホへも流す（onUnreadReady）。
 * 問いの入力待ち（AskUserQuestion）で終わったターンは、場面を ask にして未読だけ積む。OS とスマホへは入力待ちの知らせが別に出るからである。
 * どちらかの PC で開いて見ている会話（live/viewing.ts）には、未読も OS もスマホも出さない。
 * 休みの会話と統括の会話には出さない。notify_user の段（設定の notifyUser）は指示文の入切なので、切っていても数える。
 *
 * ターンを抜けたとみなすのは、入力待ち（idle、問いの waiting）と、裏だけが動く（aside）に移ったときである（UnreadHold と同じ turnRunning で見る）。
 * run が居なくなったときは積まない。
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
  /** いまの設定。知らせ方の決まりと統括の会話を読む。 */
  settings: () => Parameters<typeof notifyRulesOf>[0] & { orchestrator?: unknown };
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
  /** 会話ごとの、作業中に入った回数。読み直しの間に次のターンが始まったら、前の判定を諦めるのに使う。 */
  private turns = new Map<string, number>();
  /** 会話ごとの、最後に積んだ返答の時刻。同じ返答で 2 つ積まないためである。 */
  private given = new Map<string, number>();
  /** 最後の判定の後に notify_user が done か ask で呼ばれた会話。 */
  private notified = new Set<string>();

  constructor(private readonly deps: NotifyFallbackDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** notify_user が呼ばれたことを聞き始める。戻り値を呼ぶと外す。progress と、hangar が代わりに出した知らせは数えない。 */
  start(): () => void {
    return onNotifyKind((id, kind, immediate) => { if (kind !== 'progress' && !immediate) this.notified.add(id); });
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
        if (!this.running.has(id)) {
          this.running.set(id, now);
          this.turns.set(id, (this.turns.get(id) ?? 0) + 1);
        }
        continue;
      }
      const started = this.running.get(id);
      if (started === undefined) continue;
      this.running.delete(id);
      const notified = this.notified.delete(id);
      if (notified) continue;
      this.attempt(id, started, now, l.status === 'waiting', this.turns.get(id) ?? 0);
    }
    // run が居なくなった会話は、積まずに忘れる。
    for (const id of [...this.running.keys()]) {
      if (seen.has(id)) continue;
      this.running.delete(id);
      this.notified.delete(id);
      this.turns.delete(id);
      this.given.delete(id);
    }
  }

  private sessionIdOf(l: LiveSessionDto): string | null {
    const r = this.deps.db.prepare('select id from sessions where provider = ? and provider_session_id = ?').get(l.agent ?? 'claude-code', l.sessionId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** そのターンの返答が見えたら未読を積む。まだ見えなければ、上限まで間を置いて読み直す。 */
  private attempt(id: string, started: number, endedAt: number, question: boolean, turn: number): void {
    // 終わりの後に呼ばれた notify_user（裏の作業の間など）があれば、それに任せる。
    if (this.notified.has(id)) return;
    // 読み直しの間に次のターンが始まったら、その終わりに任せる。
    // 起動直後の短い作業中→入力待ち（返答の無い擬似のターン）が、次のターンの返答を拾って 2 つ積まないためである。
    if ((this.turns.get(id) ?? 0) !== turn) return;
    const reply = this.deps.lastReply(id);
    if (reply && reply.ts !== null && reply.ts >= started - START_SLACK_MS) {
      if (reply.ts <= (this.given.get(id) ?? -Infinity)) return;
      this.given.set(id, reply.ts);
      this.give(id, reply.text, question);
      return;
    }
    const poll = this.deps.pollMs ?? POLL_MS;
    if (this.now() + poll - endedAt > (this.deps.maxWaitMs ?? MAX_WAIT_MS)) return;
    const set = this.deps.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
    set(() => {
      try { this.attempt(id, started, endedAt, question, turn); } catch (e) { console.error('[unread] fallback failed', e instanceof Error ? e.message : e); }
    }, poll);
  }

  private give(id: string, reply: string, question: boolean): void {
    const settings = this.deps.settings();
    if (orchestratorOf(settings.orchestrator).sessionId === id) return;
    const session = getSession(this.deps.db, this.deps.live(), id);
    if (!session || (isQuietStatus(session.state?.status) && !session.woke)) return;
    const text = firstSentence(reply);
    if (!text) return;
    const rules = notifyRulesOf(settings);
    const now = this.now();
    // どちらかの PC で開いて見ている会話には、未読も OS もスマホも出さない（live/viewing.ts）。返答はその場で見えている。
    if (isViewing(id, now)) return;
    let count = session.unread?.count ?? 0;
    // 問いの入力待ちで終えたターンは、判断が要る（ask）として積む。
    const kind = question ? 'ask' : 'done';
    if (rules.unread.includes(kind)) {
      count = addUnread(this.deps.db, id, text, now, { kind });
      touchRow(this.deps.db, 'sessions', id);
    }
    if (question) return;
    const sent: NotifyTarget[] = (['os', 'phone'] as const).filter((x) => rules[x].includes('done'));
    if (sent.length > 0) noteUnreadReady(id, text, count, sent, { kind: 'done' });
  }
}
