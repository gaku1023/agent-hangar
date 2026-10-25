import type { LaunchPrepAsk, LaunchPrepChoice, LaunchPrepInstance } from '@agent-hangar/shared';
import type { LmModel } from './lmstudio.ts';

/**
 * LM Studio のモデルをどう整えるかを決める（docs/design.md「起動前の準備」）。読むだけで、何も呼ばない。
 * 決まり（2026-10-26）：
 * - 載せ替える（外す）のは hangar が載せたモデルだけ。利用者が手で載せたもの（記録に無いもの）は、答え（choice.unload）が無ければ外さずに聞く。
 * - hangar が載せたものでも、ほかの動いている会話が使っているもの（protected）は外さない。
 * - 会話と agent が別のモデルを使う設定で、合わせるとメモリに収まらなければ、1 モデルに寄せるかを聞く（既定の案内）。勧めるのは会話のモデル。
 * - 1 つで収まらないモデルは聞かずに載せてみる。LM Studio が断れば失敗として出る。
 */

/** 会話が使うモデル 1 つ。model は LM Studio のモデルの key、uses はそれを使う agent（会話の既定は '$session'、small_model は '$small'）。limit は opencode の limit.context。 */
export type WantedModel = { model: string; uses: string[]; limit: number | null };
/** hangar が載せた instance。protected は、ほかの動いている会話が使っていること。 */
export type OwnedInstance = { protected: boolean };

export type PlanInput = {
  wanted: WantedModel[];
  models: LmModel[];
  /** 設定の長さ（opencodeLocalContext）。 */
  context: number;
  /** hangar が載せた instance を ID で引く。 */
  owned: ReadonlyMap<string, OwnedInstance>;
  choice: LaunchPrepChoice;
  /** 載せてよいメモリの上限（物理メモリの 8 割）。 */
  memLimitBytes: number;
  /** 使うモデルが短く載っていれば、手で載せたものでも載せ直してよい（起動後に長さが足りずに落ちた札の「整えて再開」で、利用者が頼んだとき）。 */
  reloadShort?: boolean;
};

export type PlanAction =
  | { kind: 'load'; model: string; to: number }
  | { kind: 'reload'; model: string; instanceId: string; from: number | null; to: number }
  | { kind: 'unload'; model: string; instanceId: string };

export type Plan = { actions: PlanAction[]; ask: LaunchPrepAsk | null };

const NONE: Plan = { actions: [], ask: null };

export function planLocalModels(p: PlanInput): Plan {
  if (p.choice.skip) return NONE;
  const byKey = new Map(p.models.map((m) => [m.key, m]));
  const wanted = p.wanted.filter((w) => byKey.has(w.model));
  if (!wanted.length) return NONE;
  const size = (key: string) => byKey.get(key)?.sizeBytes ?? 0;
  const mayUnload = (id: string) => (p.owned.has(id) && !p.owned.get(id)!.protected) || (p.choice.unload ?? []).includes(id);
  const instanceOf = (m: LmModel, id: string): LaunchPrepInstance => ({ instanceId: id, model: m.key, sizeBytes: m.sizeBytes, context: m.instances.find((x) => x.id === id)?.context ?? null });

  const loads: PlanAction[] = [];
  const blocking: LaunchPrepInstance[] = [];
  let askModel: { model: string; want: number } | null = null;
  /** この起動で外す（か載せ直す）instance。 */
  const leaving = new Set<string>();
  for (const w of wanted) {
    const m = byKey.get(w.model)!;
    const to = Math.min(p.context, w.limit ?? Infinity, m.maxContext ?? Infinity);
    if (m.instances.some((x) => (x.context ?? 0) >= to)) continue;
    const short = m.instances[0];
    if (!short) { loads.push({ kind: 'load', model: m.key, to }); continue; }
    if (p.reloadShort || mayUnload(short.id)) {
      leaving.add(short.id);
      loads.push({ kind: 'reload', model: m.key, instanceId: short.id, from: short.context, to });
    } else {
      blocking.push(instanceOf(m, short.id));
      askModel ??= { model: m.key, want: to };
    }
  }

  // メモリ：残る instance と、新しく載せるものの合計を見る。
  const wantedKeys = new Set(wanted.map((w) => w.model));
  const others = p.models.flatMap((m) => m.instances.filter((x) => !leaving.has(x.id) && !(wantedKeys.has(m.key))).map((x) => ({ m, id: x.id })));
  const keptWanted = wanted.filter((w) => byKey.get(w.model)!.instances.some((x) => !leaving.has(x.id)) || loads.some((a) => a.model === w.model)).reduce((n, w) => n + size(w.model), 0);
  let total = keptWanted + others.reduce((n, o) => n + size(o.m.key), 0);
  const unloads: PlanAction[] = [];
  if (total > p.memLimitBytes && loads.length) {
    const wantedTotal = wanted.reduce((n, w) => n + size(w.model), 0);
    if (wanted.length > 1 && wantedTotal > p.memLimitBytes) {
      const suggest = (wanted.find((w) => w.uses.includes('$session')) ?? wanted[0]!).model;
      return { actions: [], ask: { kind: 'memory', models: wanted.map((w) => ({ model: w.model, uses: w.uses, sizeBytes: size(w.model) })), totalBytes: wantedTotal, limitBytes: p.memLimitBytes, suggest } };
    }
    // hangar が載せて今は使っていないもの、答えで外してよいと言われたものを、大きい順に外す。
    for (const o of [...others].sort((a, b) => size(b.m.key) - size(a.m.key))) {
      if (total <= p.memLimitBytes) break;
      if (mayUnload(o.id)) {
        unloads.push({ kind: 'unload', model: o.m.key, instanceId: o.id });
        total -= size(o.m.key);
      }
    }
    if (total > p.memLimitBytes && wantedTotal <= p.memLimitBytes) {
      const manual = others.filter((o) => !p.owned.has(o.id) && !unloads.some((u) => u.kind === 'unload' && u.instanceId === o.id));
      if (manual.length) {
        blocking.push(...manual.map((o) => instanceOf(o.m, o.id)));
        askModel ??= { model: loads[0]!.model, want: (loads[0] as { to: number }).to };
      }
    }
  }
  if (blocking.length && askModel) return { actions: [], ask: { kind: 'unload-manual', model: askModel.model, want: askModel.want, blocking } };
  return { actions: [...unloads, ...loads], ask: null };
}
