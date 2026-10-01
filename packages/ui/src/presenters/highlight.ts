/** 抜粋を、一致した語とそれ以外の塊に分けたもの。hit の塊に淡い印を付けて描く。 */
export type Segment = { text: string; hit: boolean };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 印の付け方。literal は検索語を空白で割らずに 1 つの語として当て、caseSensitive は大文字と小文字を分ける。 */
export type MarkOptions = { literal?: boolean; caseSensitive?: boolean };

/** 検索語を当てる正規表現。語が無ければ null。 */
function termsRegExp(query: string, opts: MarkOptions): RegExp | null {
  const terms = opts.literal
    ? (query === '' ? [] : [query])
    : [...new Set(query.replace(/"/g, ' ').split(/\s+/).filter((t) => t !== ''))].sort((a, b) => b.length - a.length);
  if (terms.length === 0) return null;
  return new RegExp(terms.map(escapeRegExp).join('|'), opts.caseSensitive ? 'g' : 'gi');
}

/**
 * 検索語（空白区切り）に一致する所を、大文字と小文字を問わずに印す。
 * 引用符は検索の構文なので外し、正規表現の記号はただの文字として扱う。
 * 語が重なるときは長い語を先に当てる。
 * 本文の中の検索（⌘F）は、打った文字をそのまま 1 つの語として当てる（literal）。
 */
export function markTerms(text: string, query: string, opts: MarkOptions = {}): Segment[] {
  if (text === '') return [];
  const re = termsRegExp(query, opts);
  if (!re) return [{ text, hit: false }];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** markTerms が印す塊の数。塊を作らずに数えるだけにする。 */
export function countHits(text: string, query: string, opts: MarkOptions = {}): number {
  if (text === '') return 0;
  const re = termsRegExp(query, opts);
  if (!re) return 0;
  let n = 0;
  for (const _ of text.matchAll(re)) n++;
  return n;
}
