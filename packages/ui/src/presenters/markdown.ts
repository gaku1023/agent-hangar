/**
 * Claude の返答に出る Markdown を、描く前の木に読む。
 * 読むのは段落、見出し、囲みのコード、箇条書きと番号付き（入れ子を含む）、表、引用、横線と、
 * 行の中の太字、斜体、打ち消し、インラインのコード、リンクである。
 * HTML は解釈しない。文字は React の子として渡すので、タグは文字のまま出る。
 * リンクの宛先は http と https だけを通し、ほかは名前だけの文字にする。
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; inl: Inline[] }
  | { t: 'h'; level: number; inl: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; children: Block[] }
  | { t: 'hr' };

/** リンクにしてよい宛先か。http と https のほかは null を返す。 */
export function safeHref(href: string): string | null {
  return /^https?:\/\/[^\s]+$/i.test(href) ? href : null;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
/** 見出しの開き。# の後には空白が要る。閉じの # と前後の空白は heading が文字列の操作で落とす。 */
const HEADING_OPEN = /^ {0,3}(#{1,6})\s/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
/** 区切りの行の 1 欄。`---`、`:---`、`---:`、`:---:` の形。 */
const DELIM_CELL = /^:?-+:?$/;
/**
 * 表の区切りの行か（`| --- | :---: |` など）。
 * 1 つの正規表現で書くと、欄の後ろと縦線の前後で \s* が隣り合い、長い空白の後に合わない文字が来ると時間が入力の長さの 2 乗に膨らむ（空白 4 万個で 0.6 秒）。
 * 両端の縦線を 1 つずつ外して縦線で割り、欄ごとに形を見るので、入力の長さに比例する時間で済む。
 */
export function isDelimRow(line: string): boolean {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  if (s === '') return false;
  return s.split('|').every((c) => DELIM_CELL.test(c.trim()));
}

/**
 * 見出しの段と中身。見出しでなければ null。
 * 閉じの # と前後の空白を正規表現（`\s*#*\s*$` のような並び）で落とすと、長い空白で時間が入力の長さの 3 乗に膨らむ。
 * 頁を固まらせないよう、開きだけを正規表現で読み、残りは端から削って入力の長さに比例する時間で済ませる。
 */
function heading(line: string): { level: number; text: string } | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  let text = line.slice(m[0].length).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  text = text.slice(0, end).trimEnd();
  return { level: m[1]!.length, text };
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string) => line.trim() === '';

/** 表の行を欄に割る。両端の縦線は外し、\| はただの縦線として残す。 */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isTableStart = (lines: string[], i: number) => lines[i]!.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('-') && isDelimRow(lines[i + 1]!) && (lines[i + 1]!.includes('|') || lines[i]!.trim().startsWith('|'));

/** 段落を切る行か。段落の途中にこれが来たら、そこで段落を閉じる。 */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || heading(line) !== null || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i);
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || m[1]!.length < base || m[1]!.length > base + 3 || /\d/.test(m[2]!) !== ordered) break;
    // 中身の字下げ。マーカーの後ろの空白が 5 つ以上なら、1 つだけを区切りとみなす。
    const pad = m[3]!.length === 0 || m[3]!.length > 4 ? 1 : m[3]!.length;
    const inner = m[1]!.length + m[2]!.length + pad;
    const body: string[] = [m[4]!];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (blank(line)) {
        // 空行の後が項目の続き（字下げした行）か、同じ一覧の次の項目なら、一覧は続く。
        let j = i;
        while (j < lines.length && blank(lines[j]!)) j++;
        if (j >= lines.length) break;
        const nm = ITEM.exec(lines[j]!);
        if (indentOf(lines[j]!) > base && !(nm && nm[1]!.length <= base + 3 && nm[1]!.length === base)) { for (; i < j; i++) body.push(''); continue; }
        if (nm && nm[1]!.length === base && /\d/.test(nm[2]!) === ordered) { i = j; break; }
        break;
      }
      const ind = indentOf(line);
      // 項目のマーカーより深く字下げした行は、この項目の中身（入れ子の一覧を含む）である。
      if (ind > base) { body.push(line.slice(Math.min(ind, inner))); i++; continue; }
      // 字下げの無い続きの行（怠けた続き）は、別の塊の始まりでなければ段落の続きとして拾う。
      if (!startsBlock(lines, i) && body.length > 0 && !blank(body[body.length - 1]!)) { body.push(line.trim()); i++; continue; }
      break;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    items.push(parseLines(body));
  }
  return { block: { t: 'list', ordered, start: ordered ? Number(/\d+/.exec(first[2]!)![0]) : 1, items }, next: i };
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const code: string[] = [];
      // 書きかけの返答では閉じの記号がまだ来ていない。そのときは末尾までをコードにする。
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(l)) { i++; break; }
        code.push(l.slice(Math.min(indent, indentOf(l))));
      }
      out.push({ t: 'code', lang: fence[3]!, text: code.join('\n') });
      continue;
    }
    const h = heading(line);
    if (h) { out.push({ t: 'h', level: h.level, inl: parseInline(h.text) }); i++; continue; }
    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(QUOTE, ''));
      out.push({ t: 'quote', children: parseLines(inner) });
      continue;
    }
    if (ITEM.test(line) && ITEM.exec(line)![4] !== '' ) {
      const { block, next } = parseList(lines, i);
      out.push(block);
      i = next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]!).slice(0, head.length).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      while (align.length < head.length) align.push(null);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && !blank(lines[i]!) && lines[i]!.includes('|'); i++) {
        const c = cells(lines[i]!);
        rows.push(head.map((_, k) => (c[k] ? parseInline(c[k]!) : [])));
      }
      out.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    const para: string[] = [line.trim()];
    for (i++; i < lines.length && !blank(lines[i]!) && !startsBlock(lines, i); i++) para.push(lines[i]!.trim());
    out.push({ t: 'p', inl: parseInline(para.join('\n')) });
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  return parseLines(text.replace(/\r\n?/g, '\n').split('\n'));
}

// 行の中の書式。先に現れたものから取る。コードの中身は解釈しない。
// 裸の URL は ASCII の URL の文字だけを拾い、後ろに続く日本語や句読点を宛先に含めない。
const INLINE = new RegExp([
  /(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/.source,
  /\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\))?[^()\s]*)(?:\s+"[^"\n]*")?\)/.source,
  /<(https?:\/\/[^>\s]+)>/.source,
  /(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]*[A-Za-z0-9\-_~/#@$&*+=%])/.source,
  /\*\*(?=\S)([^\n]*?\S)\*\*/.source,
  /~~(?=\S)([^\n]*?\S)~~/.source,
  /(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/.source,
].join('|'), 'g');

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (s: string) => {
    if (s === '') return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.text += s; else out.push({ t: 'text', text: s });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index;
    push(text.slice(at, idx));
    if (m[1] !== undefined) out.push({ t: 'code', text: m[2]! });
    else if (m[3] !== undefined) {
      const href = safeHref(m[4]!);
      if (href) out.push({ t: 'link', href, children: parseInline(m[3]) });
      else for (const n of parseInline(m[3])) n.t === 'text' ? push(n.text) : out.push(n);
    } else if (m[5] !== undefined) out.push({ t: 'link', href: m[5], children: [{ t: 'text', text: m[5] }] });
    else if (m[6] !== undefined) out.push({ t: 'link', href: m[6], children: [{ t: 'text', text: m[6] }] });
    else if (m[7] !== undefined) out.push({ t: 'strong', children: parseInline(m[7]) });
    else if (m[8] !== undefined) out.push({ t: 'del', children: parseInline(m[8]) });
    else if (m[9] !== undefined) out.push({ t: 'em', children: parseInline(m[9]) });
    at = idx + m[0].length;
  }
  push(text.slice(at));
  return out;
}

function inlineLeaves(inl: Inline[], out: string[]): void {
  for (const n of inl) {
    if (n.t === 'text' || n.t === 'code') out.push(n.text);
    else inlineLeaves(n.children, out);
  }
}

/**
 * 描く順に並べた文字の葉。本文の中の検索は、この葉ごとに一致を数える。
 * Markdown の描き方（views/primitives/Markdown.tsx）は、同じ順に同じ文字を印の部品へ渡す。
 */
export function mdLeaves(blocks: Block[], out: string[] = []): string[] {
  for (const b of blocks) {
    switch (b.t) {
      case 'p': case 'h': inlineLeaves(b.inl, out); break;
      case 'code': out.push(b.text); break;
      case 'list': for (const it of b.items) mdLeaves(it, out); break;
      case 'table': for (const c of b.head) inlineLeaves(c, out); for (const r of b.rows) for (const c of r) inlineLeaves(c, out); break;
      case 'quote': mdLeaves(b.children, out); break;
      case 'hr': break;
    }
  }
  return out;
}
