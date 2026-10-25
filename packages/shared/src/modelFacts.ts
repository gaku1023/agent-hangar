/**
 * opencode のモデルの小窓（新しいセッションの「モデル」の札）に添える、手書きの事実の表（docs/design.md「opencode のモデルの小窓」）。
 * 料金、コンテキストの長さ、ツール呼び出しの対応は、opencode の `/api/model` と models.dev から取れる。
 * データの扱い（学習に使うか、記録するか）と、費用の型（定額など）は、どこの API も返さないので、各社の公開情報を読んでここに書く。
 * 書いた日を MODEL_FACTS_UPDATED に持ち、MODEL_FACTS_STALE_DAYS を過ぎたら画面は「要確認」を添える。
 * 無料モデルの顔ぶれは数週間で入れ替わるので、モデル ID を 1 つずつ名指しせず、`*` を含む型で書く（顔ぶれは `/api/model` が決める）。
 */

/** 表を書いた日（YYYY-MM-DD）。表を直したら一緒に進める。 */
export const MODEL_FACTS_UPDATED = '2026-10-25';
/** 書いた日からこの日数を過ぎたら、画面は手書きの事実に「要確認」を添える。 */
export const MODEL_FACTS_STALE_DAYS = 30;

/** 費用の型。ローカル、無料、従量、定額。 */
export type ModelCostKind = 'local' | 'free' | 'metered' | 'plan';

/**
 * データの扱い。
 * on-device は PC の外へ送らない（この PC のサーバー）、no-training は学習に使わない、retain-30d は 30 日間保持、
 * may-train は学習に使われうる、provider-logs はプロバイダー側で記録する。後ろの 2 つは画面で目立たせる。
 */
export type ModelDataUse = 'on-device' | 'no-training' | 'retain-30d' | 'may-train' | 'provider-logs';

/**
 * プロバイダーごとの事実。
 * name は画面に出す名前（opencode の名前が分かりにくいときだけ書く）。cost は API の料金から決められない費用の型（定額、ローカル）。
 * data はそのプロバイダーのモデルの既定のデータの扱い。limitedFree は、無料のモデルが期間限定であること。
 * monthlyUsd は定額の月額（米ドル）で、設定のプロバイダーの追加の一覧に「定額 · 月 $10」の形で添える。
 */
export type ModelProviderFact = { name?: string; cost?: 'plan' | 'local'; data?: ModelDataUse; limitedFree?: boolean; monthlyUsd?: number };

/** モデルごとのデータの扱い。match はプロバイダーの中のモデル ID で、`*` は任意の文字の並び。上から順に最初に合ったものを使う。 */
export type ModelDataFact = { provider: string; match: string; data: ModelDataUse };

/** プロバイダーの ID（opencode の providerID）ごとの事実。 */
export const PROVIDER_FACTS: Readonly<Record<string, ModelProviderFact>> = {
  opencode: { name: 'OpenCode Zen', limitedFree: true },
  'opencode-go': { name: 'OpenCode Go', cost: 'plan', data: 'no-training', monthlyUsd: 10 },
  'zai-coding-plan': { name: 'GLM Coding Plan', cost: 'plan', data: 'no-training' },
  'github-copilot': { name: 'GitHub Copilot', cost: 'plan', data: 'no-training' },
  deepseek: { data: 'no-training' },
  zai: { name: 'Z.AI（GLM）', data: 'no-training' },
  lmstudio: { name: 'LM Studio', cost: 'local' },
  ollama: { name: 'Ollama', cost: 'local' },
};

/** モデルごとのデータの扱い（OpenCode Zen の無料のもの、OpenCode Go の一部）。 */
export const MODEL_FACTS: readonly ModelDataFact[] = [
  { provider: 'opencode', match: 'big-pickle', data: 'may-train' },
  { provider: 'opencode', match: 'mimo-*', data: 'may-train' },
  { provider: 'opencode', match: 'flint-*', data: 'may-train' },
  { provider: 'opencode', match: 'nemotron-*', data: 'provider-logs' },
  { provider: 'opencode', match: 'beam-*', data: 'retain-30d' },
  { provider: 'opencode', match: 'glm-*', data: 'no-training' },
  { provider: 'opencode', match: 'deepseek-*', data: 'no-training' },
  { provider: 'opencode', match: 'kimi-*', data: 'no-training' },
  { provider: 'opencode', match: 'claude-*', data: 'retain-30d' },
  { provider: 'opencode-go', match: 'muse-spark-contributor*', data: 'may-train' },
];

const DAY_MS = 86_400_000;

/** 手書きの事実が古いか。now はミリ秒、updated は YYYY-MM-DD（省けば MODEL_FACTS_UPDATED）。日付は UTC の 0 時で数える。 */
export function modelFactsStale(now: number, updated: string = MODEL_FACTS_UPDATED): boolean {
  const at = Date.parse(`${updated}T00:00:00Z`);
  if (Number.isNaN(at)) return true;
  return now - at > MODEL_FACTS_STALE_DAYS * DAY_MS;
}

/** プロバイダーの事実。書いていなければ空。 */
export function providerFactOf(provider: string): ModelProviderFact {
  return Object.prototype.hasOwnProperty.call(PROVIDER_FACTS, provider) ? PROVIDER_FACTS[provider]! : {};
}

const matches = (pattern: string, id: string): boolean => {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(id);
};

/** モデルのデータの扱い。モデルの型、プロバイダーの既定の順に引き、どちらにも無ければ null（分からない）。 */
export function dataUseOf(provider: string, model: string): ModelDataUse | null {
  const hit = MODEL_FACTS.find((f) => f.provider === provider && matches(f.match, model));
  return hit?.data ?? providerFactOf(provider).data ?? null;
}
