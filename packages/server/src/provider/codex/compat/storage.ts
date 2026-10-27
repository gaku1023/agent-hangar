/**
 * rollout の置かれ方の見張り（docs/design.md「Codex の互換の見張り」）。
 * hangar の本文の同期は、rollout が追記だけで伸びること（resume で前の行が書き換わらないこと）と、
 * 名前が .jsonl のまま変わらないこと（zst に切り替わらないこと）に頼る。この 2 つを比べる道具。
 */

export type FeatureRow = { stage: string; enabled: boolean };

/** `codex features list` の 1 行（名前、段階、真偽。段階は空白を含みうる）を読む。読めない行は null。 */
export function parseFeatureList(text: string): Record<string, FeatureRow> {
  const out: Record<string, FeatureRow> = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z][a-z0-9_]*)\s{2,}(.+?)\s{2,}(true|false)\s*$/.exec(line.trim());
    if (m) out[m[1]!] = { stage: m[2]!, enabled: m[3] === 'true' };
  }
  return out;
}

/** 圧縮の切り替えが頼る機能の名前。既定が true になる、または段階が変わると、同じ会話が jsonl と zst で名前を変えうる。 */
export const COMPRESSION_FEATURE = 'local_thread_store_compression';

/** 見本の行と今の行の差。見つからない、段階が違う、既定が違うを文にして返す。 */
export function compressionDrifts(want: FeatureRow, now: FeatureRow | undefined): string[] {
  if (!now) return [`${COMPRESSION_FEATURE} is gone from features list (fixture: ${want.stage}, default ${want.enabled})`];
  const out: string[] = [];
  if (now.enabled !== want.enabled) out.push(`${COMPRESSION_FEATURE} default changed from ${want.enabled} to ${now.enabled}`);
  if (now.stage !== want.stage) out.push(`${COMPRESSION_FEATURE} stage changed from "${want.stage}" to "${now.stage}"`);
  return out;
}

/** 追記だけで伸びたか。後が前を先頭に含み、かつ伸びていること。違えば理由を返す（空なら追記だけ）。 */
export function appendOnlyDrifts(before: Buffer, after: Buffer): string[] {
  if (after.length < before.length) return [`rollout shrank (${before.length} to ${after.length} bytes)`];
  const at = firstDifference(before, after);
  if (at !== -1) return [`rollout byte ${at} was rewritten (earlier lines are assumed unchanged)`];
  if (after.length === before.length) return ['rollout did not grow on resume (one line is assumed to be appended)'];
  return [];
}

function firstDifference(a: Buffer, b: Buffer): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
