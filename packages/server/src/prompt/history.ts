import fs from 'node:fs';

const cache = new Map<string, { key: string; uses: Map<string, number> }>();

/**
 * Claude Code の入力の履歴（history.jsonl）から、セッションの最初の一言になったコマンドの回数を数える。
 * 履歴は古い順に並ぶので、sessionId を初めて見た行がそのセッションの最初の一言である。
 * 途中で打つコマンド（/compact など）と区別するために、最初の一言だけを数える。
 * 読むだけで、ファイルの更新時刻と大きさが変わるまで結果を覚えておく。
 */
export function firstPromptUses(file: string): Map<string, number> {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return new Map(); }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.uses;
  const uses = new Map<string, number>();
  const seen = new Set<string>();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d: { display?: unknown; sessionId?: unknown };
    try { d = JSON.parse(line) as typeof d; } catch { continue; }
    if (typeof d?.sessionId !== 'string' || seen.has(d.sessionId)) continue;
    seen.add(d.sessionId);
    const m = /^\/([\w:.-]+)/.exec(typeof d.display === 'string' ? d.display.trim() : '');
    if (m) uses.set(m[1]!, (uses.get(m[1]!) ?? 0) + 1);
  }
  cache.set(file, { key, uses });
  return uses;
}
