/**
 * 事後の要約を作るもの（設定の「要約エンジン」）。
 * off は作らない（既定）、claude は claude -p、openai は OpenAI 互換の URL（LM Studio、Ollama、vLLM など）である。
 * 会話の中で Claude が書く要約（set_session_summary）は、どれを選んでも書かれる。
 */
export const SUMMARY_ENGINES = ['off', 'claude', 'openai'] as const;
export type SummaryEngine = (typeof SUMMARY_ENGINES)[number];

export function isSummaryEngine(v: unknown): v is SummaryEngine {
  return typeof v === 'string' && (SUMMARY_ENGINES as readonly string[]).includes(v);
}

/** 要約に使う Claude のモデルの既定。軽いモデルで足り、使用枠の減りも小さい。 */
export const DEFAULT_SUMMARY_CLAUDE_MODEL = 'haiku';

/** 一覧から選べるモデルの別名。新しいセッションの札と、設定の既定のモデルと、要約の Claude のモデルで使う。一覧に無い名前も打てる。 */
export const MODEL_CHOICES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/**
 * モデルの名前として受ける形。claude の --model へそのまま渡すので、引数として読まれる先頭のハイフンと、空白や記号を断る。
 * 別名（haiku）、版付きの名前（claude-sonnet-4-5）、文脈の長さの印（opus[1m]）、Bedrock の形（us.anthropic.x:0）を通す。
 */
export function isModelName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]*$/.test(v);
}
