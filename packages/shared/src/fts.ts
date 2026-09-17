/** 空白で区切り、空のトークンを捨てる。 */
function tokenize(text: string): string[] {
  return text.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * 検索語を trigram で当たる長さ（3 コードポイント以上）の long と、当たらない short に分ける。
 * short は MATCH に載せられないので、呼び出し側が like で補う。
 */
export function splitFtsTokens(text: string): { long: string[]; short: string[] } {
  const long: string[] = [];
  const short: string[] = [];
  for (const t of tokenize(text)) ([...t].length >= 3 ? long : short).push(t);
  return { long, short };
}

/**
 * 利用者の入力を FTS5 の MATCH 式に変える。
 * ハイフンを含む語を素のまま渡すと列指定と解釈されるので、トークンごとに二重引用符で包む。
 * trigram トークナイザは 3 文字未満の語に当たらないので、その語は落とす。
 */
export function toFtsQuery(text: string): string | null {
  const tokens = splitFtsTokens(text).long;
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}
