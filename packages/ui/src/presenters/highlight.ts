/** 抜粋を、一致した語とそれ以外の塊に分けたもの。hit の塊に淡い印を付けて描く。 */
export type Segment = { text: string; hit: boolean };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 検索語（空白区切り）に一致する所を、大文字と小文字を問わずに印す。
 * 引用符は検索の構文なので外し、正規表現の記号はただの文字として扱う。
 * 語が重なるときは長い語を先に当てる。
 */
export function markTerms(text: string, query: string): Segment[] {
  if (text === '') return [];
  const terms = [...new Set(query.replace(/"/g, ' ').split(/\s+/).filter((t) => t !== ''))].sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [{ text, hit: false }];
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
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
