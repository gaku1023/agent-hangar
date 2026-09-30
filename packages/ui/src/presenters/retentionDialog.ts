import type { RetentionPreviewLine, RetentionUsageDto } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { bytesLabel, daysLabel, expiresBy } from './retention.ts';

export type UsageBarProps = { nowLabel: string; projLabel: string | null; freeLabel: string; nowPct: number; projPct: number; warn: boolean };
export type RetentionDialogProps = { title: string; lead: string; path: string; lines: RetentionPreviewLine[] | null; bar: UsageBarProps | null; backupDir: string; otherPcs: boolean; shrinkNote: string | null; reloaded: boolean; showOther: boolean; writing: boolean; previewError: string | null };

/**
 * 使用量のバー。幅はいまの使用量と空きの和を 100% にする（本文が使える限りの広さ）。
 * 見込みが空きの半分を超えるときは警告にする。
 */
export function usageBar(usage: RetentionUsageDto | null, projectedBytes: number | null, days: number): UsageBarProps | null {
  if (!usage) return null;
  const total = usage.bytes + usage.freeBytes;
  const pct = (b: number) => (total > 0 ? Math.min(100, (b / total) * 100) : 0);
  return {
    nowLabel: `いま ${bytesLabel(usage.bytes)}`,
    projLabel: projectedBytes === null ? null : `${daysLabel(days)}たつと約 ${bytesLabel(projectedBytes)}`,
    freeLabel: usage.freeBytes > 0 ? `空き ${bytesLabel(usage.freeBytes)}` : '空きは分かりません',
    nowPct: pct(usage.bytes),
    projPct: projectedBytes === null ? 0 : pct(Math.max(projectedBytes, usage.bytes)),
    warn: projectedBytes !== null && usage.freeBytes > 0 && projectedBytes > usage.freeBytes / 2,
  };
}

export function presentRetentionDialog(state: State, store: Store, now: number): RetentionDialogProps | null {
  const o = state.overlay;
  if (o.kind !== 'retention') return null;
  const cur = store.retention?.days ?? 30;
  const p = store.retentionPreview && store.retentionPreview.days === o.days ? store.retentionPreview : null;
  const shrinking = o.days < cur;
  // 縮めると、新しい期限を既に過ぎた本文が次の起動で消える。
  const lost = shrinking ? Object.values(store.sessions).filter((s) => s.transcriptMtime !== null && expiresBy(s.transcriptMtime, o.days) <= now).length : 0;
  const replacing = p?.lines.some((l) => l.kind === 'del') ?? false;
  return {
    title: shrinking ? `会話の保持期間を ${daysLabel(o.days)}に縮めます` : `会話の保持期間を ${daysLabel(o.days)}にします`,
    lead: replacing ? 'Claude Code の設定ファイルの、次の 1 行を書き換えます。' : 'Claude Code の設定ファイルに、次の 1 行を足します。',
    path: p?.path ?? '',
    lines: p?.lines ?? null,
    bar: usageBar(store.retention?.usage ?? null, p?.projectedBytes ?? null, o.days),
    backupDir: p ? `${p.backupDir}/` : '',
    otherPcs: store.settings?.syncClaudeConfig ?? false,
    shrinkNote: lost > 0 ? `次に Claude Code を使い始めたとき、${lost} 件の会話の本文が削除されます。` : null,
    reloaded: o.reloaded,
    showOther: o.from === 'banner',
    writing: o.writing,
    previewError: o.previewError,
  };
}
