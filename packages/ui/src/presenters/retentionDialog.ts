import type { RetentionPreviewLine, RetentionUsageDto, Translate } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';
import { bytesLabel, expiresBy } from './retention.ts';

/** 保持期間の言い方。365 の倍数なら年、それ以外は日で言う（`daysLabel` の辞書版）。1 だけは単数で言う。 */
export function periodLabel(t: Translate, days: number): string {
  if (days % 365 === 0) return days / 365 === 1 ? t('retentionDialog.period.oneYear') : t('retentionDialog.period.years', { n: days / 365 });
  return days === 1 ? t('retentionDialog.period.oneDay') : t('retentionDialog.period.days', { n: days });
}

export type UsageBarProps = { nowLabel: string; projLabel: string | null; freeLabel: string; nowPct: number; projPct: number; warn: boolean };
export type RetentionDialogProps = { title: string; lead: string; path: string; lines: RetentionPreviewLine[] | null; bar: UsageBarProps | null; backupDir: string; otherPcs: boolean; shrinkNote: string | null; reloaded: boolean; showOther: boolean; writing: boolean; previewError: string | null };

/**
 * 使用量のバー。幅はいまの使用量と空きの和を 100% にする（本文が使える限りの広さ）。
 * 見込みが空きの半分を超えるときは警告にする。
 */
export function usageBar(usage: RetentionUsageDto | null, projectedBytes: number | null, days: number, t: Translate): UsageBarProps | null {
  if (!usage) return null;
  const total = usage.bytes + usage.freeBytes;
  const pct = (b: number) => (total > 0 ? Math.min(100, (b / total) * 100) : 0);
  return {
    nowLabel: t('retentionDialog.bar.now', { size: bytesLabel(usage.bytes) }),
    projLabel: projectedBytes === null ? null : t('retentionDialog.bar.projected', { period: periodLabel(t, days), size: bytesLabel(projectedBytes) }),
    freeLabel: usage.freeBytes > 0 ? t('retentionDialog.bar.free', { size: bytesLabel(usage.freeBytes) }) : t('retentionDialog.bar.freeUnknown'),
    nowPct: pct(usage.bytes),
    projPct: projectedBytes === null ? 0 : pct(Math.max(projectedBytes, usage.bytes)),
    warn: projectedBytes !== null && usage.freeBytes > 0 && projectedBytes > usage.freeBytes / 2,
  };
}

export function presentRetentionDialog(state: State, store: Store, now: number): RetentionDialogProps | null {
  const o = state.overlay;
  if (o.kind !== 'retention') return null;
  const t = translatorOf(store);
  const cur = store.retention?.days ?? 30;
  const p = store.retentionPreview && store.retentionPreview.days === o.days ? store.retentionPreview : null;
  const shrinking = o.days < cur;
  // 縮めると、新しい期限を既に過ぎた本文が次の起動で消える。
  const lost = shrinking ? Object.values(store.sessions).filter((s) => s.transcriptMtime !== null && expiresBy(s.transcriptMtime, o.days) <= now).length : 0;
  const replacing = p?.lines.some((l) => l.kind === 'del') ?? false;
  return {
    title: t(shrinking ? 'retentionDialog.title.shrink' : 'retentionDialog.title.set', { period: periodLabel(t, o.days) }),
    lead: t(replacing ? 'retentionDialog.lead.replace' : 'retentionDialog.lead.add'),
    path: p?.path ?? '',
    lines: p?.lines ?? null,
    bar: usageBar(store.retention?.usage ?? null, p?.projectedBytes ?? null, o.days, t),
    backupDir: p ? `${p.backupDir}/` : '',
    otherPcs: store.settings?.syncClaudeConfig ?? false,
    shrinkNote: lost > 0 ? t('retentionDialog.notice.shrink', { n: lost }) : null,
    reloaded: o.reloaded,
    showOther: o.from === 'banner',
    writing: o.writing,
    previewError: o.previewError,
  };
}
