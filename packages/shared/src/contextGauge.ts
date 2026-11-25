/**
 * 会話の文脈の量（トークン）の色の境目。サイドバーの輪と「448K/1000K」の表示が、この 2 つの値で黄と赤に変わる。
 * 設定の contextWarnTokens と contextAlertTokens で変えられる。
 */
export const DEFAULT_CONTEXT_WARN_TOKENS = 300_000;
export const DEFAULT_CONTEXT_ALERT_TOKENS = 400_000;
const MAX_CONTEXT_TOKENS = 10_000_000;

/** 境目として受ける値。1000 から 1000 万までの整数。 */
export const isContextTokens = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1000 && v <= MAX_CONTEXT_TOKENS;

export const contextWarnTokensOf = (s: { contextWarnTokens?: number }): number => (isContextTokens(s.contextWarnTokens) ? s.contextWarnTokens : DEFAULT_CONTEXT_WARN_TOKENS);
export const contextAlertTokensOf = (s: { contextAlertTokens?: number }): number => (isContextTokens(s.contextAlertTokens) ? s.contextAlertTokens : DEFAULT_CONTEXT_ALERT_TOKENS);
