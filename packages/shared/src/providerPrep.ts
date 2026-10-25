/**
 * opencode の接続先の「準備」（docs/design.md「接続先の準備」）。OpenAI 互換サーバーの行ごとに、利用者が書くコマンドである。
 * start は会話を始める前に hangar が走らせ、終了コード 0 で準備済みとする。stop は任意で、その接続先を使う最後の会話が終わって stopAfter 分後に走らせる。
 * コマンドは PC ごとに違うので、この PC の設定（settings.json の opencodeProviderPrep）にだけ置き、同期しない。opencode の設定にも書かない。
 */

/** 止める時期（分）。null は止めない。 */
export type ProviderPrepStopAfter = 5 | 15 | 60 | null;
export const PROVIDER_PREP_STOP_AFTER: readonly ProviderPrepStopAfter[] = [5, 15, 60, null];
/** 止める時期の既定。GPU を取り直すのに数分かかるので、短すぎると次の会話で待つ。 */
export const DEFAULT_PROVIDER_PREP_STOP_AFTER: ProviderPrepStopAfter = 15;
/** コマンドの長さの上限。 */
export const PROVIDER_PREP_COMMAND_MAX = 2000;

export type ProviderPrep = { start: string; stop: string; stopAfter: ProviderPrepStopAfter };

const isStopAfter = (v: unknown): v is ProviderPrepStopAfter => (PROVIDER_PREP_STOP_AFTER as readonly unknown[]).includes(v);
const commandOf = (v: unknown): string | null => (typeof v === 'string' && v.length <= PROVIDER_PREP_COMMAND_MAX && !v.includes('\0') ? v.trim() : null);
/** 接続先の ID の形。opencode の設定の鍵で、改行と制御文字は受けない。 */
export const isProviderPrepId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);

/** 準備 1 つを読む。始める前のコマンドが空か、形が違えば null（準備なし）。 */
export function providerPrepOf(v: unknown): ProviderPrep | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const start = commandOf(r.start);
  if (!start) return null;
  return { start, stop: commandOf(r.stop) ?? '', stopAfter: isStopAfter(r.stopAfter) ? r.stopAfter : DEFAULT_PROVIDER_PREP_STOP_AFTER };
}

/** 接続先ごとの準備を読む。形の違う項目は捨てる。 */
export function providerPrepsOf(v: unknown): Record<string, ProviderPrep> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, ProviderPrep> = {};
  for (const [id, raw] of Object.entries(v)) {
    const p = isProviderPrepId(id) ? providerPrepOf(raw) : null;
    if (p) out[id] = p;
  }
  return out;
}
