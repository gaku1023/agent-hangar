/**
 * Claude Code は、利用者が貼り付けた文を記録に `<pasted_content id="xxxx">…</pasted_content id="xxxx">` で包んで残す。
 * タグは Claude が貼り付けと本人の言葉を見分けるためのもので、画面には出さない。
 * 記録と Claude に渡る文はそのままにし、見せるときにここで分ける。
 */
export type PastedPart = { paste: boolean; text: string };

const BLOCK = /<pasted_content id="([^"]+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;
const HEAD_OPEN = /^\s*<pasted_content id="[^"]+">\n?/;

/**
 * 本文を貼り付けと本人の文に、書かれた順で分ける。前後の空行は詰め、空の部分は捨てる。
 * 開きと閉じの id がそろったものだけを外す。崩れた形は本文 1 つのまま返す。
 * ただし頭が開きタグで閉じが無いもの（一覧の一行のように途中で切った文）は、開きタグだけ外して貼り付けとする。
 */
export function pastedParts(text: string): PastedPart[] {
  const parts: PastedPart[] = [];
  const own = (s: string) => {
    const t = s.replace(/^\s*\n/, '').trimEnd();
    if (t.trim() !== '') parts.push({ paste: false, text: t });
  };
  let at = 0;
  for (const m of text.matchAll(BLOCK)) {
    own(text.slice(at, m.index));
    parts.push({ paste: true, text: m[2] ?? '' });
    at = m.index + m[0].length;
  }
  if (at === 0) {
    const head = HEAD_OPEN.exec(text);
    if (head && !text.includes('</pasted_content id=')) return [{ paste: true, text: text.slice(head[0].length).trimEnd() }];
    return [{ paste: false, text }];
  }
  own(text.slice(at));
  return parts;
}

/** 一覧の一行や見出しに出す文。本人の文を先に出し、無ければ貼り付けの中身を出す。 */
export function utteranceHead(text: string): string {
  const parts = pastedParts(text);
  if (parts.length === 1 && !parts[0]!.paste) return text;
  const own = parts.filter((p) => !p.paste);
  return (own.length > 0 ? own : parts).map((p) => p.text).join('\n');
}

/** タグだけ外して、書かれた順に並べた文（検索の索引向け）。 */
export function stripPasted(text: string): string {
  const parts = pastedParts(text);
  if (parts.length === 1 && !parts[0]!.paste) return text;
  return parts.map((p) => p.text).join('\n');
}
