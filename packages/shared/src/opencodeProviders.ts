import { providerFactOf } from './modelFacts.ts';
import type { OpencodeModelCost, OpencodeProviderWhere } from './opencodeOptions.ts';

/**
 * 設定の「連携 › opencode › プロバイダー」（GET /api/opencode/providers ほか）。
 * つないだ先の一覧と、追加の一覧（opencode の `/api/integration` のカタログ）を同じ答えで返す。
 * API キーは opencode の integration に渡すだけで、この形には載せない（hangar には残さない）。
 */

/** 追加の一覧の先頭に「おすすめ」として並べるプロバイダー（opencode の integration の ID）。並びもこの順にする。 */
export const RECOMMENDED_PROVIDERS = ['deepseek', 'zai', 'opencode-go', 'zai-coding-plan', 'github-copilot'] as const;

/**
 * 一覧の右に出す料金の型。
 * metered は従量、metered-free は従量で 0 円のモデルもある（無料枠あり）、free は全部 0 円、plan は定額、local はこの PC で動くもの。
 */
export type ProviderPriceKind = 'metered' | 'metered-free' | 'free' | 'plan' | 'local';

/** 料金の型と添えるもの。monthlyUsd は定額の月額（米ドル、分かるときだけ）、loginOnly は API キーでは接続できず、ログインが必要なこと。 */
export type ProviderPrice = { kind: ProviderPriceKind; monthlyUsd: number | null; loginOnly: boolean };

/** ログインの方法（opencode の oauth の方法）。id は opencode の methodID、label は opencode の表示名（英語）。 */
export type OpencodeLoginMethod = { id: string; label: string };

/**
 * 追加の一覧の 1 行。
 * key は API キーで接続できるか、logins はログインの方法。price は料金の型で、分からなければ null。
 */
export type OpencodeCatalogEntryDto = { id: string; name: string; recommended: boolean; key: boolean; logins: OpencodeLoginMethod[]; price: ProviderPrice | null };

/**
 * つないだ先の接続の仕方。
 * key は API キー、login はログイン、env は環境変数、config は opencode.json に書いたもの（OpenAI 互換のサーバーなど）、
 * auto は何もしなくても使えるもの（LM Studio の自動の検出、OpenCode Zen の無料のモデル）。
 */
export type OpencodeConnectionVia = 'key' | 'login' | 'env' | 'config' | 'auto';

/**
 * つないだ先の 1 行。
 * url は opencode.json の baseURL（無ければ null）、where はその宛先（この PC、内側の網、それ以外）。envName は環境変数で接続しているときの名前。
 * canChangeKey は「API キーを変更」、canDisconnect は「接続を解除」を出すか。「モデル ID を追加」はどの行にも出す。
 */
export type OpencodeConnectedDto = {
  id: string; name: string; via: OpencodeConnectionVia; envName: string | null;
  url: string | null; where: OpencodeProviderWhere; price: ProviderPrice | null;
  canChangeKey: boolean; canDisconnect: boolean;
};

/** 設定のプロバイダーの面の一式。configPath は書き換える opencode.json（~ で縮めない絶対パス）。 */
export type OpencodeProvidersDto = { connected: OpencodeConnectedDto[]; catalog: OpencodeCatalogEntryDto[]; configPath: string };

/** ログインを始めた答え。url をブラウザで開き、mode が code なら、表示されたコードを入れて完了する。instructions は opencode の英語の案内。 */
export type OpencodeLoginDto = { attemptId: string; url: string; instructions: string; mode: 'auto' | 'code' };
/** ログインの進み。 */
export type OpencodeLoginStatusDto = { status: 'pending' | 'complete' | 'failed' | 'expired'; message: string | null };

/** OpenAI 互換のサーバーを足す本文。apiKey は任意で、opencode の integration に渡す。 */
export type OpencodeCustomProviderBody = { name: string; url: string; apiKey?: string };

/** 追加の一覧を並べる。おすすめを RECOMMENDED_PROVIDERS の順で先頭に、残りを名前の順（大小を問わない）にする。 */
export function orderProviderCatalog<T extends { id: string; name: string }>(rows: readonly T[]): (T & { recommended: boolean })[] {
  const rec: readonly string[] = RECOMMENDED_PROVIDERS;
  const top = RECOMMENDED_PROVIDERS.flatMap((id) => rows.filter((r) => r.id === id)).map((r) => ({ ...r, recommended: true }));
  const rest = rows.filter((r) => !rec.includes(r.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))
    .map((r) => ({ ...r, recommended: false }));
  return [...top, ...rest];
}

/**
 * プロバイダーの料金の型。手書きの表（modelFacts.ts）の定額とローカルを先に使い、無ければ models.dev の料金（costs、分からないモデルは null）で決める。
 * key は API キーで接続できるか。定額で API キーの方法が無ければ「要ログイン」を添える。
 */
export function providerPriceOf(id: string, costs: readonly (OpencodeModelCost | null)[] | null, key: boolean): ProviderPrice | null {
  const fact = providerFactOf(id);
  if (fact.cost === 'plan') return { kind: 'plan', monthlyUsd: fact.monthlyUsd ?? null, loginOnly: !key };
  if (fact.cost === 'local') return { kind: 'local', monthlyUsd: null, loginOnly: false };
  const known = (costs ?? []).filter((c): c is OpencodeModelCost => c !== null);
  if (!known.length) return null;
  const zero = known.filter((c) => c.input === 0 && c.output === 0).length;
  const kind: ProviderPriceKind = zero === known.length ? 'free' : zero > 0 ? 'metered-free' : 'metered';
  return { kind, monthlyUsd: null, loginOnly: false };
}
