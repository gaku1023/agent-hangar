/**
 * 新しいセッションで opencode を選んだときの選択肢（GET /api/opencode/options）。
 * PC のダイアログとスマホ（F2）が同じ形を使う。
 * 中身は opencode の serve の API（`/api/agent`、`/api/model`、`/api/provider`、`/api/config`）から作る。
 */

/** モード（opencode の primary のエージェント。build、plan など）。description は opencode の設定の説明で、無ければ null。 */
export type OpencodeModeOption = { id: string; description: string | null };

/** 100 万トークンあたりの料金（米ドル）。input は入力、output は出力。 */
export type OpencodeModelCost = { input: number; output: number };

/**
 * モデル。id は起動の params.model に入れる `provider/model` の形、label は opencode の表示名、group はプロバイダーの表示名、provider はプロバイダーの ID。
 * tools はツール呼び出しに対応するか（偽ならエージェントでは使えない）。context はコンテキストの長さ（トークン）で、分からなければ null。
 * cost は料金（opencode が返したもの、無ければ models.dev の保存から）で、分からなければ null。
 * missing は、この PC のローカルのサーバー（LM Studio など）に聞いて、無かったこと。確かめられなかったときと古いサーバーの答えでは省く。
 */
export type OpencodeModelOption = { id: string; label: string; group: string; provider: string; tools: boolean; context: number | null; cost: OpencodeModelCost | null; missing?: boolean };

/**
 * プロバイダーの宛先。device はこの PC（LM Studio、Ollama、127.0.0.1）、lan は内側の網（私用のアドレス、.local など。自前のサーバー）、remote はそれ以外。
 * 小窓は device と lan をローカルとし、device にだけ「PC 外への送信なし」を添える。
 */
export type OpencodeProviderWhere = 'device' | 'lan' | 'remote';

/** つないだプロバイダー。where は URL の宛先（OpencodeProviderWhere）。 */
export type OpencodeProviderOption = { id: string; name: string; where: OpencodeProviderWhere };

/**
 * 選択肢の一式。
 * version と verified は手元の opencode の版と、確かめた範囲に入るか。
 * defaultModel は opencode.json の既定のモデル（`provider/model`）で、無ければ null。モデルの札の「デフォルト」に添える。
 * providers はつないだプロバイダーで、opencode の並びのまま。
 * pricesAt は models.dev から料金を取った時刻（ミリ秒）で、まだ取れていなければ null。モデルの小窓の下端に出す。
 * fetchedAt は serve から取った時刻（ミリ秒）。stale は、取り直せずに前に取った一覧を返したときに真になる。
 */
/** OpenCode Zen のプロバイダーの ID。 */
export const OPENCODE_ZEN_PROVIDER = 'opencode';

/**
 * opencode.json の既定がその PC で使えないときに、代わりに選ぶモデル（#698）。既定が使えるとき、既定が無いときは null。
 * 代わりは OpenCode Zen の無料で deepseek を含むもの、Zen の無料の先頭、使える先頭の順に選ぶ。Zen の無料のモデルは入れ替わるので、名前ではなく決まりで選ぶ。
 * 使えるのは、ローカルのサーバーに無いもの（missing）とツール呼び出しに対応しないものを除いた行。使えるモデルが 1 つも無ければ null。
 */
export function opencodeFallbackModel(o: { models: readonly OpencodeModelOption[]; defaultModel: string | null }): string | null {
  if (o.defaultModel === null || o.models.some((m) => m.id === o.defaultModel && m.missing !== true)) return null;
  const usable = o.models.filter((m) => m.missing !== true && m.tools);
  const zenFree = usable.filter((m) => m.provider === OPENCODE_ZEN_PROVIDER && m.cost !== null && m.cost.input === 0 && m.cost.output === 0);
  return (zenFree.find((m) => /deepseek/i.test(m.id)) ?? zenFree[0] ?? usable[0])?.id ?? null;
}

export type OpencodeOptionsDto = {
  version: string | null;
  verified: boolean;
  modes: OpencodeModeOption[];
  models: OpencodeModelOption[];
  providers: OpencodeProviderOption[];
  defaultModel: string | null;
  pricesAt: number | null;
  fetchedAt: number;
  stale: boolean;
};
