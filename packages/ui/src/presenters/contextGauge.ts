import { contextAlertTokensOf, contextWarnTokensOf } from '@agent-hangar/shared';

export type ContextLevel = 'none' | 'warn' | 'alert';
/** 会話ごとの今の context の量。輪の満ち具合（fraction）、色（level）、乗せたときと状態の行の右端に出す文（label）。 */
export type ContextGauge = { tokens: number; size: number | null; level: ContextLevel; fraction: number; label: string };

/** k の単位でそろえた表記。1M も 1000K と書く（窓と並べたとき桁がそろう）。 */
export const ctxK = (n: number): string => `${Math.round(n / 1000)}K`;

type GaugeStats = { contextTokens?: number | null; contextSize?: number | null };
type GaugeSettings = { contextWarnTokens?: number; contextAlertTokens?: number };

/**
 * 色の境目。窓が alert の値以上なら設定の warn と alert、窓が小さいときは窓の 75% と 90%。
 * warn が alert 以上の設定は、warn を alert と同じに扱う（黄を飛ばして赤になる）。
 */
export function contextGaugeOf(stats: GaugeStats | undefined, settings: GaugeSettings): ContextGauge | null {
  const tokens = stats?.contextTokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return null;
  const size = typeof stats?.contextSize === 'number' && stats.contextSize > 0 ? stats.contextSize : null;
  const alertSet = contextAlertTokensOf(settings);
  const warnSet = Math.min(contextWarnTokensOf(settings), alertSet);
  const [warn, alert] = size !== null && size < alertSet ? [size * 0.75, size * 0.9] : [warnSet, alertSet];
  const level: ContextLevel = tokens >= alert ? 'alert' : tokens >= warn ? 'warn' : 'none';
  const fraction = Math.max(0, Math.min(1, tokens / (size ?? alertSet)));
  return { tokens, size, level, fraction, label: size !== null ? `${ctxK(tokens)}/${ctxK(size)}` : ctxK(tokens) };
}
