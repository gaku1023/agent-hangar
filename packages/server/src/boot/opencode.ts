import os from 'node:os';
import { opencodeEnabledOf } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import { findOpencode } from '../config/tools.ts';
import { catalogPath, ModelsDevCatalog } from '../provider/opencode/catalog.ts';
import { LocalOpencode } from '../provider/opencode/compat/version.ts';
import { OpencodeOptionsService } from '../provider/opencode/options.ts';
import { ServeManager, type OpencodeVersionNoticeSeed } from '../provider/opencode/serve/manager.ts';
import { ServeRegistry, serveRegistryPath, sweepLeftoverServes } from '../provider/opencode/serve/registry.ts';

export type OpencodeParts = {
  /** 会話ごとの serve。設定が切なら ensure は OpencodeDisabledError で断る。 */
  serves: ServeManager;
  /** 新しいセッションの選択肢（モードとモデル）。取った一覧を場所ごとに手元に持つ。 */
  options: OpencodeOptionsService;
  /** 起動のときの掃除が済むと解決する。 */
  swept: Promise<unknown>;
  /** 最後に出た、範囲の外の版の知らせの種。表示は段 C（C7）で作る。 */
  versionNotice: () => OpencodeVersionNoticeSeed | null;
  /** hangar の終わりの後片付け。起こした serve を全部止める。上限を過ぎたら待たずに返す。 */
  stop: (ms: number) => Promise<void>;
};

/**
 * opencode（ベータ）の serve の管理を組む。
 * 前の hangar が残した serve の掃除だけは、設定の入り切りに関わらず起動のときに回す（切にしたあとで落ちた回の残りを止めるため）。
 * 設定が切なら、ほかには何も起こさない。
 */
export function bootOpencode(
  p: { home: string; settings: { current: Pick<Settings, 'opencodeEnabled'> } },
  o: { bin?: () => string | null; version?: () => Promise<string | null> } = {},
): OpencodeParts {
  const bin = o.bin ?? (() => findOpencode());
  const local = new LocalOpencode({ bin });
  const registry = new ServeRegistry(serveRegistryPath(p.home));
  const log = (line: string): void => { console.log(line); };
  const swept = sweepLeftoverServes(registry, { log }).catch((e: unknown) => {
    console.warn(`[opencode] could not sweep leftover serve processes: ${(e as Error).message}`);
  });
  let notice: OpencodeVersionNoticeSeed | null = null;
  const serves = new ServeManager({
    enabled: () => opencodeEnabledOf(p.settings.current),
    bin,
    version: o.version ?? (async () => (await local.status()).version),
    registry,
    ready: swept,
    log,
    onVersionNotice: (seed) => { notice = seed; },
  });
  // models.dev の料金の保存。取りに行くのは選択肢を取ったときだけ（1 日 1 回まで）。
  const catalog = new ModelsDevCatalog({ file: catalogPath(p.home), log });
  const options = new OpencodeOptionsService({ serves, status: () => local.status(), home: os.homedir(), catalog });
  return {
    serves,
    options,
    swept,
    versionNotice: () => notice,
    stop: async (ms) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        serves.stopAll(),
        new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    },
  };
}
