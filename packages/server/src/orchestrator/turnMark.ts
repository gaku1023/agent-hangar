import { VOICE_WINDOW_MARK } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

/**
 * 送り込みの印と声の由来（docs/design.md「統括」の安全の境界の 3 と 4、と弱い声のターン）。
 *
 * 統括の今のターンが、何で始まったかを 3 つに分けて返す。
 * - user：利用者の打鍵か、強い声（`[voice]`）で始まった。
 * - weak：弱い声（`[voice:window]`、返答の直後の窓など）で始まった。読む道具と自分の記録の道具だけを通す（mcp/orchestratorTools.ts）。
 * - fed：hangar が送り込んだ出来事の文（`[hangar]`）か、要約で続けた頭で始まった。
 * answer_ask(by: 'user') と set_permission_policy は、user のターンでだけ通す（userTurnOf）。
 *
 * 見るのは索引の session_stats（ターンの数と、ターンを始めた最後の入力の頭）である。
 * - 送った直後は、索引がまだその文を読んでいないことがある。そこで渡したときのターンの数を覚え（noteFedTurn、noteWeakTurn）、数が増えるまではその種類と読む。
 *   前の利用者の入力を、今のターンの入力と読み違えないためである。両方の印が待っていれば、弱い側に倒す。
 * - 入力がまだ無い会話は fed とする（今までの「利用者のターンではない」と同じ扱い）。
 * 迷う場合はいつも断る側に倒す。断られた統括は、利用者へ伝えて答えを待つだけで済む。
 * 印はメモリだけに持つ。再起動の直後は印が無いが、最後の入力の頭で見分けられる。
 */

/** 出来事の文の頭。言語によらず同じにする（見分けに使う）。 */
export const FEED_MARK = '[hangar]';
/** 要約で続けた会話の頭（Claude Code が利用者の入力として書く）。 */
const COMPACT_HEAD = 'This session is being continued from a previous conversation';

export type TurnStrength = 'user' | 'weak' | 'fed';

const fedMarks = new WeakMap<Db, Map<string, number>>();
const weakMarks = new WeakMap<Db, Map<string, number>>();

const statsOf = (db: Db, sessionId: string) =>
  db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(sessionId) as { turns: number | null; last_prompt: string | null } | undefined;

const note = (marks: WeakMap<Db, Map<string, number>>, db: Db, sessionId: string): void => {
  let m = marks.get(db);
  if (!m) marks.set(db, (m = new Map()));
  m.set(sessionId, statsOf(db, sessionId)?.turns ?? 0);
};

/** 統括へ出来事の文を渡した。今のターンの数を覚える。 */
export function noteFedTurn(db: Db, sessionId: string): void {
  note(fedMarks, db, sessionId);
}

/** 統括へ弱い声の文を渡した。今のターンの数を覚える。 */
export function noteWeakTurn(db: Db, sessionId: string): void {
  note(weakMarks, db, sessionId);
}

/** 入力の頭が、hangar の出来事の文か、要約の頭か。 */
export function isFedPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(FEED_MARK) || t.startsWith(COMPACT_HEAD);
}

/** 入力の頭が、弱い声の印か。 */
export function isWeakPrompt(text: string): boolean {
  return text.trimStart().startsWith(VOICE_WINDOW_MARK);
}

/** 統括の今のターンの強さ。 */
export function turnStrengthOf(db: Db, sessionId: string): TurnStrength {
  const st = statsOf(db, sessionId);
  const turns = st?.turns ?? 0;
  const pending = (marks: WeakMap<Db, Map<string, number>>) => {
    const at = marks.get(db)?.get(sessionId);
    return at !== undefined && turns <= at;
  };
  if (pending(weakMarks)) return 'weak';
  if (pending(fedMarks)) return 'fed';
  if (!st || !st.last_prompt) return 'fed';
  if (isFedPrompt(st.last_prompt)) return 'fed';
  if (isWeakPrompt(st.last_prompt)) return 'weak';
  return 'user';
}

/** 統括の今のターンが、利用者の入力（打鍵か強い声）で始まったか。 */
export function userTurnOf(db: Db, sessionId: string): boolean {
  return turnStrengthOf(db, sessionId) === 'user';
}
