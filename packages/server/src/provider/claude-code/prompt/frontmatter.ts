/**
 * SKILL.md とコマンドの先頭にある frontmatter を、鍵と値の文字の組で返す。
 * YAML の全部は読まない。使うのは name、description、argument-hint、user-invocable だけで、どれも 1 つの文字の値だからである。
 * 折り返しの値（> と |）は、字下げした行を空白でつなぐ。読めない行は飛ばす。
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const buf: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) buf.push(lines[++i]!.trim());
      v = buf.filter(Boolean).join(' ');
    } else if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[kv[1]!] = v;
  }
  return out;
}
