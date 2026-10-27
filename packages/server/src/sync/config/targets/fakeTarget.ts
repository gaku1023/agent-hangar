import type { ConfigTarget } from './types.ts';

/** 試験用の仮の対象。頭が `<name>:` の id を持ち、集めるものは無い。本番の登録には入れない。 */
export function fakeTarget(name: string, o: { enabled?: boolean } = {}): ConfigTarget {
  return {
    name,
    owns: (id) => id.startsWith(`${name}:`),
    parseId: (id) => (id.startsWith(`${name}:`) ? { kind: 'codex-file', ref: { type: 'file', rel: id.slice(name.length + 1) } } : null),
    enabled: () => o.enabled ?? true,
    collect: () => ({ items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } }),
    planWrite: () => { throw new Error('fake target does not plan'); },
    write: () => { throw new Error('fake target does not write'); },
    needsApproval: () => false,
    isMachineBound: () => false,
  };
}
