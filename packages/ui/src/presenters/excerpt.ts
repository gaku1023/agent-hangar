import type { SessionDto } from '@agent-hangar/shared';

/**
 * プロジェクトのカードの抜粋の決め方。
 * 要約を優先し、無ければ雑音を除いた発言を使う。
 * 雑音の規則は試作（`docs/superpowers/specs/2026-10-01-ux-refresh/home-lists.html` の C 軸の表）に合わせる。
 */

/** 貼り付けと画像の置き換え表記（`[Pasted text #1 +5 lines]`、`[Image #2]`）。 */
const PASTE_MARK = /\[(?:Pasted text #\d+(?: \+\d+ lines?)?|Image #\d+)\]/g;
/** HTML の断片か、コードの囲みで始まる発言。人の書く依頼は `<` や ``` で始まらない。 */
const MARKUP_HEAD = /^(?:<[A-Za-z!/?]|```)/;
/** スラッシュコマンド。`/Users/…` のようなパスは、名前の直後が空白か終わりでないので当たらない。 */
const SLASH_COMMAND = /^\/[A-Za-z][\w:.-]*(?:\s|$)/;
/** URL だけの発言。 */
const URL_ONLY = /^https?:\/\/\S+$/;
/** exit、q、:q、ok のような英字 1 語だけの打鍵。 */
const ONE_WORD = /^:?[A-Za-z]+$/;

/**
 * 発言から雑音を除いた文を返す。
 * 貼り付けの置き換え表記は取り除き、残りを見る。
 * HTML やコードだけの発言、スラッシュコマンド、URL だけの発言、英字 1 語だけの打鍵、空の発言は null にする。
 */
export function meaningfulUtterance(text: string | null): string | null {
  if (text === null) return null;
  const t = text.replace(PASTE_MARK, ' ').trim();
  if (t === '') return null;
  if (MARKUP_HEAD.test(t) || SLASH_COMMAND.test(t) || URL_ONLY.test(t) || ONE_WORD.test(t)) return null;
  return t;
}

/** カードの抜粋。fromPrompt は要約ではなく発言から取ったことを表し、カードはその旨を小さく添える。 */
export type CardExcerpt = { text: string; fromPrompt: boolean };

/**
 * セッションを最後に動いた順に新しいものから見て、最初に取れた抜粋を返す。
 * 1 件のセッションの中では、要約の 1 文を発言より先に使う。
 * 土台の要約（source が baseline）の 1 文は最初の発言の写しなので、要約とはみなさない。
 * 手元に届く発言は最初の発言（firstPrompt）だけである。
 */
export function cardExcerpt(sessions: SessionDto[]): CardExcerpt | null {
  const newest = [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  for (const s of newest) {
    const fromSummary = s.summary && s.summary.source !== 'baseline' ? meaningfulUtterance(s.summary.oneLiner) : null;
    if (fromSummary) return { text: fromSummary, fromPrompt: false };
    const said = meaningfulUtterance(s.firstPrompt);
    if (said) return { text: said, fromPrompt: true };
  }
  return null;
}
