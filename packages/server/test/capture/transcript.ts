// 採っている最中のトランスクリプトを、行ごとに JSON で読む小さな道具。採る道具（run.ts）が使う。
// 書きかけの行（claude が書いている途中）と壊れた行は飛ばす。

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function records(text: string): Rec[] {
  const out: Rec[] = [];
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    try {
      const r: unknown = JSON.parse(l);
      if (isRec(r)) out.push(r);
    } catch { /* 書きかけの行 */ }
  }
  return out;
}

/** assistant の行の本文にある、tool_use の塊。 */
function toolUses(rec: Rec): Rec[] {
  if (rec.type !== 'assistant' || !isRec(rec.message) || !Array.isArray(rec.message.content)) return [];
  return rec.message.content.filter((b): b is Rec => isRec(b) && b.type === 'tool_use');
}

/**
 * 1 つ目の指示の Bash（sleep 20）を、claude が実際に呼んだか。
 * 利用者の指示の文にも sleep 20 があるので、文字列の一致では足りない。assistant の Bash の tool_use で、command に sleep 20 があるときだけ真にする。
 */
export function hasBashSleep(text: string): boolean {
  return records(text).some((r) => toolUses(r).some((b) => b.name === 'Bash' && isRec(b.input) && typeof b.input.command === 'string' && b.input.command.includes('sleep 20')));
}

/** 名前の形（英数字と _ -）でないものは、中身を出さずに (other) にまとめる。パスや本文を、種類の名前として出さないためである。 */
const nameOf = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(v) ? v : '(other)');

/**
 * 筋書きや伏せ残しの確かめで落ちたときに、標準エラーへ出す要約。値（パス、本文）は含めない。
 * 採れたファイルの名前と行数、トランスクリプトの行の type ごとの数、tool_use の名前の一覧である。
 */
export function failureSummary(files: [name: string, lines: number][], transcriptText: string): string {
  const recs = records(transcriptText);
  const types = new Map<string, number>();
  const tools = new Set<string>();
  for (const r of recs) {
    const t = nameOf(r.type);
    types.set(t, (types.get(t) ?? 0) + 1);
    for (const b of toolUses(r)) tools.add(nameOf(b.name));
  }
  return [
    '採れたもの:',
    ...files.map(([name, lines]) => `- ${name}: ${lines} 行`),
    `トランスクリプトの行の type（読めた ${recs.length} 行）:`,
    ...[...types].sort().map(([t, n]) => `- ${t}: ${n}`),
    `tool_use の名前: ${tools.size === 0 ? '（なし）' : [...tools].sort().join(', ')}`,
  ].join('\n');
}
