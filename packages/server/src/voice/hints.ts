import { normalize } from './filters.ts';

const FIXED = ['Claude Code', 'Codex', 'opencode', 'hangar', 'Sonnet', 'Opus', 'Haiku', 'GitHub', 'vitest', 'TypeScript', 'pull request'];
const MAX_HINTS = 60;
const MAX_TITLE = 40;

/** カタカナをひらがなに寄せる。呼びかけ語の名前と読みを同じ形で比べるため。 */
export function fold(s: string): string {
  return normalize(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 認識に渡す語彙のヒント。呼びかけ語の名前（と読み）は入れない。重複を除き 60 語まで。 */
export function buildHints(input: { sessionTitles: string[]; projectNames: string[]; callName: string }): string[] {
  const call = fold(input.callName);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...FIXED, ...input.projectNames, ...input.sessionTitles]) {
    const w = raw.trim();
    if (w === '' || w.length > MAX_TITLE) continue;
    const f = fold(w);
    if (f === '' || (call !== '' && f === call) || seen.has(f)) continue;
    seen.add(f);
    out.push(w);
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}

export function hintContext(hints: string[]): string {
  return hints.join(', ');
}
