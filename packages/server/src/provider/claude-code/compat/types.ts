import type { CompatContract } from '@agent-hangar/shared';

/**
 * ずれの 1 回分。value は「どこが、どう違ったか」（type=foo、status=(missing) など）。
 * version は値を読んだ元に載っていた claude の版で、無ければ null（記録の側で手元の版を入れる）。
 */
export type Drift = { contract: CompatContract; value: string; version: string | null };
/** ずれを受け取る口。CompatLog が実物で、試験は配列に積むだけのものを渡す。 */
export type CompatSink = { note(d: Drift): void };
/** 何もしない口。渡されなかったときの既定である。 */
export const NO_COMPAT: CompatSink = { note: () => {} };

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * ずれの値を、最初の = で「どこが」と「どう違ったか」に分ける（`system.subtype=foo` は `['system.subtype', 'foo']`）。
 * = の無い値は null。記録に残った値が今もずれかを決めるとき（current.ts）に使う。
 */
export function splitDriftValue(value: string): [key: string, got: string] | null {
  const i = value.indexOf('=');
  return i < 0 ? null : [value.slice(0, i), value.slice(i + 1)];
}

/** 記録に載っている claude の版。無いか空なら null。 */
export function versionOfRecord(raw: unknown): string | null {
  return isRec(raw) && typeof raw.version === 'string' && raw.version !== '' ? raw.version : null;
}
