/**
 * 新しいセッションで Codex を選んだときの選択肢（GET /api/codex/options）。
 * 中身は `codex debug models`（codex が持つモデルの一覧）から作る。app-server を起こさずに取れる。
 */

/** 推論の段階 1 つ。id は起動の params.effort に入れる値（low、medium、high など）、description は codex の説明。 */
export type CodexEffortOption = { id: string; description: string };

/**
 * モデル 1 つ。id は起動の params.model に入れる値（codex の slug）、label は表示名。
 * efforts はそのモデルで選べる推論の段階（codex の並びのまま）、defaultEffort はそのモデルの既定の段階で、分からなければ null。
 */
export type CodexModelOption = { id: string; label: string; description: string; efforts: CodexEffortOption[]; defaultEffort: string | null };

/** 選択肢の一式。version と verified は手元の codex の版と、確かめた範囲に入るか。fetchedAt は取った時刻（ミリ秒）。 */
export type CodexOptionsDto = { version: string | null; verified: boolean; models: CodexModelOption[]; fetchedAt: number };
