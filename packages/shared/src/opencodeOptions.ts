/**
 * 新しいセッションで opencode を選んだときの選択肢（GET /api/opencode/options）。
 * PC のダイアログとスマホ（F2）が同じ形を使う。
 * 中身は opencode の serve の API（`/api/agent`、`/api/model`、`/api/provider`、`/api/config`）から作る。
 */

/** モード（opencode の primary のエージェント。build、plan など）。description は opencode の設定の説明で、無ければ null。 */
export type OpencodeModeOption = { id: string; description: string | null };

/** モデル。id は起動の params.model に入れる `provider/model` の形、label は opencode の表示名、group はプロバイダーの表示名。 */
export type OpencodeModelOption = { id: string; label: string; group: string };

/**
 * 選択肢の一式。
 * version と verified は手元の opencode の版と、確かめた範囲に入るか。
 * defaultModel は opencode.json の既定のモデル（`provider/model`）で、無ければ null。モデルの札の「デフォルト」に添える。
 * fetchedAt は serve から取った時刻（ミリ秒）。stale は、取り直せずに前に取った一覧を返したときに真になる。
 */
export type OpencodeOptionsDto = {
  version: string | null;
  verified: boolean;
  modes: OpencodeModeOption[];
  models: OpencodeModelOption[];
  defaultModel: string | null;
  fetchedAt: number;
  stale: boolean;
};
