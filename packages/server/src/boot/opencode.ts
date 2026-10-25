import os from 'node:os';
import { opencodeEnabledOf } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import { findOpencode } from '../config/tools.ts';
import { catalogPath, ModelsDevCatalog } from '../provider/opencode/catalog.ts';
import { LocalOpencode } from '../provider/opencode/compat/version.ts';
import { opencodeConfigPath } from '../provider/opencode/configFile.ts';
import { OpencodeProvidersService } from '../provider/opencode/integration.ts';
import { OpencodeExporter } from '../provider/opencode/export.ts';
import { OpencodeOptionsService } from '../provider/opencode/options.ts';
import { ServeManager, type OpencodeVersionNoticeSeed } from '../provider/opencode/serve/manager.ts';
import { ServeRegistry, serveRegistryPath, sweepLeftoverServes } from '../provider/opencode/serve/registry.ts';

export type OpencodeParts = {
  /** 会話ごとの serve。設定が切なら ensure は OpencodeDisabledError で断る。 */
  serves: ServeManager;
  /** 新しいセッションの選択肢（モードとモデル）。取った一覧を場所ごとに手元に持つ。 */
  options: OpencodeOptionsService;
  /** 設定のプロバイダー（つないだ先、API キー、ログイン、OpenAI 互換のサーバー）。変えたら options を取り直させる。 */
  providers: OpencodeProvidersService;
  /** 同期で上げる本文の書き出し（`opencode session export`）。会話の serve が起きていればそれにつなぐ。 */
  exporter: OpencodeExporter;
  /** 起動のときの掃除が済むと解決する。 */
  swept: Promise<unknown>;
  /** 最後に出た、範囲の外の版の知らせの種。画面へは起こすたびに onVersionNotice で配る（C7）。 */
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
  p: { home: string; settings: { current: Pick<Settings, 'opencodeEnabled'> }; db?: Db },
  o: {
    bin?: () => string | null;
    version?: () => Promise<string | null>;
    /** 範囲の外の版で serve を起こすたびに呼ぶ。server.ts が画面へ配る（右下の札の種、C7）。 */
    onVersionNotice?: (seed: OpencodeVersionNoticeSeed) => void;
  } = {},
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
    onVersionNotice: (seed) => { notice = seed; o.onVersionNotice?.(seed); },
  });
  // models.dev の料金の保存。取りに行くのは選択肢を取ったときだけ（1 日 1 回まで）。
  const catalog = new ModelsDevCatalog({ file: catalogPath(p.home), log });
  const options = new OpencodeOptionsService({ serves, status: () => local.status(), home: os.homedir(), catalog });
  const providers = new OpencodeProvidersService({ serves, home: os.homedir(), configFile: opencodeConfigPath(os.homedir()), catalog, onChange: () => options.forget() });
  // serve は hangar の会話の ID で持つので、opencode の会話の ID から引き直す。DB が無ければ（試験）serve につながず私用のサーバで書き出す。
  const hangarIdOf = p.db?.prepare("select id from sessions where provider = 'opencode' and provider_session_id = ? and deleted_at is null");
  const exporter = new OpencodeExporter({
    home: p.home,
    bin,
    serveOf: (providerSessionId) => {
      const row = hangarIdOf?.get(providerSessionId) as { id: string } | undefined;
      return row ? serves.get(row.id) : null;
    },
  });
  return {
    serves,
    options,
    providers,
    exporter,
    swept,
    versionNotice: () => notice,
    stop: async (ms) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        providers.close().then(() => serves.stopAll()),
        new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    },
  };
}
