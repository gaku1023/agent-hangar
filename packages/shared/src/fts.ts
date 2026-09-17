/**
 * 利用者の入力を FTS5 の MATCH 式に変える。
 * ハイフンを含む語を素のまま渡すと列指定と解釈されるので、トークンごとに二重引用符で包む。
 * trigram トークナイザは 3 文字未満の語に当たらないので、その語は落とす。
 */
export function toFtsQuery(text: string): string | null {
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter((t) => [...t].length >= 3);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}
