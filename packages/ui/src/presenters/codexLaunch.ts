import type { CodexEffortOption, CodexOptionsDto, Translate } from '@agent-hangar/shared';

/** 推論の初めの値。モデルが選べるならこれ、選べなければそのモデルの既定の段階。 */
export const CODEX_DEFAULT_EFFORT = 'medium';

/**
 * そのモデルで選べる推論の段階。モデルが空（デフォルト）のときは、一覧の先頭（codex が先に勧めるモデル）の段階を使う。
 * 一覧が届く前と、一覧に無いモデルは空。
 */
export function codexEffortsOf(data: CodexOptionsDto | null, model: string): CodexEffortOption[] {
  if (!data) return [];
  const m = model === '' ? data.models[0] : data.models.find((x) => x.id === model);
  return m?.efforts ?? [];
}

/**
 * モデルの札の値。remembered は前回の値（利用者がいま選んだ値も同じ扱い）で、空はデフォルト。
 * 一覧が届いていて、そこから前回のモデルが消えていたら、デフォルトに戻す。一覧がまだ無いときは、消えたかどうか分からないので前回のままにする。
 */
export function codexModelChoice(remembered: string, data: CodexOptionsDto | null): string {
  if (!remembered || !data) return remembered;
  return data.models.some((m) => m.id === remembered) ? remembered : '';
}

/**
 * 推論の札の値。選んだ段階がそのモデルで選べればそのまま、選べなければ medium に戻す。
 * medium も選べないモデルは、そのモデルの既定の段階（それも無ければ先頭）にする。一覧が届く前は、選んだ値か medium のまま。
 */
export function codexEffortChoice(picked: string, data: CodexOptionsDto | null, model: string): string {
  const efforts = codexEffortsOf(data, model);
  if (efforts.length === 0) return picked || CODEX_DEFAULT_EFFORT;
  if (efforts.some((e) => e.id === picked)) return picked;
  if (efforts.some((e) => e.id === CODEX_DEFAULT_EFFORT)) return CODEX_DEFAULT_EFFORT;
  const m = model === '' ? data?.models[0] : data?.models.find((x) => x.id === model);
  return efforts.find((e) => e.id === m?.defaultEffort)?.id ?? efforts[0]!.id;
}

/** エージェントの一覧の Codex の行に添える「codex 0.164.0 · 検証済み」。版が分からなければ null。 */
export function codexAgentNote(t: Translate, data: CodexOptionsDto | null): string | null {
  if (!data?.version) return null;
  return t(data.verified ? 'launch.agent.codexVerified' : 'launch.agent.codexUnverified', { version: data.version });
}
