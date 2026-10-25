import type { AgentDriver, AgentKind } from './types.ts';

/** sessions.provider の値から、そのエージェントの driver を引く口。 */
export type Agents = {
  of(provider: string): AgentDriver;
};

/** 新しい会話を起こすときの既定のエージェント。 */
export const DEFAULT_AGENT: AgentKind = 'claude-code';

/** driver を種類で引けるようにまとめる。同じ種類を 2 つ渡すのは組み立ての誤りなので投げる。 */
export function agentsOf(drivers: readonly AgentDriver[]): Agents {
  const byKind = new Map<string, AgentDriver>();
  for (const d of drivers) {
    if (byKind.has(d.kind)) throw new Error(`duplicate agent driver: ${d.kind}`);
    byKind.set(d.kind, d);
  }
  return {
    of(provider) {
      const d = byKind.get(provider);
      if (!d) throw new Error(`no agent driver for provider: ${provider}`);
      return d;
    },
  };
}
