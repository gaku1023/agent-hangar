import fs from 'node:fs';
import path from 'node:path';
import { CODEX_CONFIG_FILE } from '../ids.ts';
import { parseToml } from '../edit/tomlParse.ts';

export type CodexPluginHold = 'marketplace-missing';

/**
 * 受け手の保留（Codex のプラグイン）。`plugins.<名前>@<配布元>.enabled` の配布元が、この PC の config.toml の
 * `[marketplaces.<配布元>]` にも `<CODEX_HOME>/plugins/cache/<配布元>` にも無ければ、有効にしても意味がないので保留にする。
 */
export function holdOfCodexPlugin(keyPath: readonly string[], env: { codexHome: string }): CodexPluginHold | null {
  if (keyPath[0] !== 'plugins' || keyPath.length < 2) return null;
  const id = keyPath[1]!;
  const at = id.lastIndexOf('@');
  if (at <= 0 || at === id.length - 1) return null;
  const market = id.slice(at + 1);
  if (market === '.' || market === '..' || /[\\/]/.test(market)) return null;
  try {
    const tree = parseToml(fs.readFileSync(path.join(env.codexHome, CODEX_CONFIG_FILE), 'utf8')).tree;
    const m = tree.marketplaces;
    if (m && typeof m === 'object' && !Array.isArray(m) && Object.prototype.hasOwnProperty.call(m, market)) return null;
  } catch { /* 読めない・無いときは、宣言が無いのと同じ */ }
  try { if (fs.statSync(path.join(env.codexHome, 'plugins', 'cache', market)).isDirectory()) return null; } catch { /* 無い */ }
  return 'marketplace-missing';
}
