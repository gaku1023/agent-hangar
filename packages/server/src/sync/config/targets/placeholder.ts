import type { ConfigTarget, TargetContext } from './types.ts';

/**
 * まだ何も運ばない対象の枠。owns は常に false、collect は空で、`placeholder` の印を持つ。
 * 印のある対象は束の `targets` に載せない（載せると、他の PC の同じ対象の項目が「こちらも扱える」ことになり、まだ書けないのに受けてしまう）。
 * 実装する PR は、この枠をやめて本物の対象を書き（`placeholder` を外す）、ここから出る。
 */
export function placeholderTarget(name: string, enabled: (ctx: TargetContext) => boolean = (ctx) => ctx.switches?.[name] === true): ConfigTarget {
  return {
    name,
    placeholder: true,
    owns: () => false,
    parseId: () => null,
    enabled,
    collect: () => ({ items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } }),
    planWrite: () => { throw new Error(`target ${name} is not implemented`); },
    write: () => { throw new Error(`target ${name} is not implemented`); },
    needsApproval: () => false,
    isMachineBound: () => false,
  };
}
