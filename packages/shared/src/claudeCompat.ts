/**
 * Claude Code との互換（docs/design.md「Claude Code との互換」）。
 * hangar が頼る Claude Code の形式を 6 つの契約に分け、知らない値に出会ったら「ずれ」として記録する。
 */
export type CompatContract = 'transcript' | 'registry' | 'statusline' | 'claude-dir' | 'cli' | 'screen';
export const COMPAT_CONTRACTS: readonly CompatContract[] = ['transcript', 'registry', 'statusline', 'claude-dir', 'cli', 'screen'];

/**
 * 記録したずれの 1 件。同じ契約と値の組は 1 件にまとめ、回数と最初と最後に見た時刻を持つ。
 * version はその値を最後に読んだ元の版で、分からなければ null。
 */
export type CompatDriftDto = { contract: CompatContract; value: string; version: string | null; count: number; firstSeenAt: number; lastSeenAt: number };
/** GET /api/compat。verifiedVersion は見本のうち最も新しい版、localVersion は手元の claude --version（読めなければ null）。drifts は最後に見た時刻の新しい順。 */
export type CompatDto = { verifiedVersion: string; localVersion: string | null; drifts: CompatDriftDto[] };
/** GET /api/readiness の compat。設定の互換の節と、始める前の確認の互換の行が読む。 */
export type CompatSummaryDto = { verifiedVersion: string; localVersion: string | null; driftCount: number };
/** 互換の 3 つの状態。drift はずれが 1 件以上、unverified は手元の版が確かめた版より新しい、ok はそれ以外。 */
export type CompatState = 'ok' | 'unverified' | 'drift';

/**
 * claude の版（2.1.292 の形）を比べる。a が古ければ負、同じなら 0、新しければ正。
 * 区切りごとに数として比べ、足りない区切りと数でない区切りは 0 とみなす。
 */
export function compareClaudeVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 互換の状態。止めてはいないので、未確認の版はずれより弱い。 */
export function compatState(s: CompatSummaryDto): CompatState {
  if (s.driftCount > 0) return 'drift';
  if (s.localVersion !== null && compareClaudeVersions(s.localVersion, s.verifiedVersion) > 0) return 'unverified';
  return 'ok';
}
