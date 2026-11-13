import type { Db } from '../db/open.ts';

/**
 * 送り込みの印（docs/design.md「統括」の安全の境界の 3 と 4）。
 *
 * 統括の今のターンが、利用者の入力で始まったか、hangar が送り込んだ出来事の文で始まったかを見分ける。
 * answer_ask(by: 'user') と set_permission_policy は、利用者の入力で始まったターンでだけ通す。
 *
 * 見るのは索引の session_stats（ターンの数と、ターンを始めた最後の入力の頭）である。
 * - 最後の入力が `[hangar]` で始まれば、出来事で始まったターンである。
 * - 送り込んだ直後は、索引がまだその文を読んでいないことがある。そこで渡したときのターンの数を覚え（noteFedTurn）、数が増えるまでは偽にする。
 *   前の利用者の入力を、今のターンの入力と読み違えないためである。
 * - 入力がまだ無い会話と、要約で続けた頭（Claude Code が利用者の入力として書く）も偽にする。
 * 迷う場合はいつも偽（断る）側に倒す。断られた統括は、利用者へ伝えて答えを待つだけで済む。
 * 印はメモリだけに持つ。再起動の直後は印が無いが、最後の入力の頭で見分けられる。
 */

/** 出来事の文の頭。言語によらず同じにする（見分けに使う）。 */
export const FEED_MARK = '[hangar]';
/** 要約で続けた会話の頭（Claude Code が利用者の入力として書く）。 */
const COMPACT_HEAD = 'This session is being continued from a previous conversation';

const marks = new WeakMap<Db, Map<string, number>>();

const statsOf = (db: Db, sessionId: string) =>
  db.prepare('select turns, last_prompt from session_stats where session_id = ?').get(sessionId) as { turns: number | null; last_prompt: string | null } | undefined;

/** 統括へ出来事の文を渡した。今のターンの数を覚える。 */
export function noteFedTurn(db: Db, sessionId: string): void {
  let m = marks.get(db);
  if (!m) marks.set(db, (m = new Map()));
  m.set(sessionId, statsOf(db, sessionId)?.turns ?? 0);
}

/** 入力の頭が、hangar の出来事の文か、要約の頭か。 */
export function isFedPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(FEED_MARK) || t.startsWith(COMPACT_HEAD);
}

/** 統括の今のターンが、利用者の入力で始まったか。 */
export function userTurnOf(db: Db, sessionId: string): boolean {
  const st = statsOf(db, sessionId);
  if (!st || !st.last_prompt) return false;
  const fedAt = marks.get(db)?.get(sessionId);
  if (fedAt !== undefined && (st.turns ?? 0) <= fedAt) return false;
  return !isFedPrompt(st.last_prompt);
}
