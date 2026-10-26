import type { CodexModelOption } from '@agent-hangar/shared';

/** slug の頭の版（gpt-6.1-sol の 6）。読めなければ null。 */
const majorOf = (id: string): number | null => {
  const hit = /^gpt-(\d+)/.exec(id);
  return hit ? Number(hit[1]) : null;
};

/**
 * Codex のモデルを、いまの世代と以前の世代に分ける（新しいセッションのモデルの札）。
 * codex debug models は世代を返さないので、slug の頭の版で見る。いちばん新しい版より古い gpt を older に入れ、版の読めない名前は current に残す。
 * どちらも元の並び（codex の priority の順）を保つ。
 */
export function splitCodexModels<T extends Pick<CodexModelOption, 'id'>>(models: T[]): { current: T[]; older: T[] } {
  const majors = models.map((m) => majorOf(m.id)).filter((n): n is number => n !== null);
  if (!majors.length) return { current: models, older: [] };
  const top = Math.max(...majors);
  const isOlder = (m: T) => { const n = majorOf(m.id); return n !== null && n < top; };
  return { current: models.filter((m) => !isOlder(m)), older: models.filter(isOlder) };
}
