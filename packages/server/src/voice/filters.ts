/** 認識の結果のうち、統括へ送らないものを決める（docs/design.md「机の音声」）。 */
export type DropReason = 'quiet' | 'hallucination' | 'ack' | 'hintEcho';

const QUIET_DBFS = -45;
const HALLUCINATIONS = ['ご視聴ありがとうございました', 'ご清聴ありがとうございました', 'チャンネル登録よろしくお願いします', 'おやすみなさい'].map((s) => normalize(s));
const ACKS = ['はい', 'うん', 'ええ'];

/** 比べるための正規化。全角半角をそろえ、句読点・記号・空白を除き、小文字にする。 */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

export function dropReason(seg: { text: string; dbfs: number }, ctx: { hints: string[]; inWindow: boolean }): DropReason | null {
  if (seg.dbfs < QUIET_DBFS) return 'quiet';
  const n = normalize(seg.text);
  if (HALLUCINATIONS.includes(n)) return 'hallucination';
  if (ctx.inWindow && ACKS.includes(n)) return 'ack';
  if (isHintEcho(seg.text, n, ctx.hints)) return 'hintEcho';
  return null;
}

function isHintEcho(text: string, normalized: string, hints: string[]): boolean {
  if (normalized === '') return false;
  const set = new Set(hints.map(normalize));
  const tokens = text.split(/[,、，]/).map(normalize).filter((t) => t !== '');
  const matched = tokens.filter((t) => set.has(t));
  if (matched.length < 3) return false;
  const chars = matched.reduce((a, t) => a + t.length, 0);
  return chars / normalized.length >= 0.6;
}
