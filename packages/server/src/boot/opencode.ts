import os from 'node:os';
import path from 'node:path';
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
import { OpencodeTransfer } from '../provider/opencode/transfer.ts';
import { ServeManager, serveSecrets, type OpencodeVersionNoticeSeed, type ServeStarter } from '../provider/opencode/serve/manager.ts';
import { disposeServePane, ensureServeWrapper, startServeInPane, type PaneServeHost } from '../provider/opencode/serve/pane.ts';
import { adoptableServes, defaultProbe, ServeRegistry, serveRegistryPath, sweepLeftoverServes } from '../provider/opencode/serve/registry.ts';
import { startServe } from '../provider/opencode/serve/spawn.ts';
import { listAliveRuns } from '../runs/queries.ts';
import type { PaneOps } from '../tmux/pane.ts';

export type OpencodeParts = {
  /** 会話ごとの serve。設定が切なら ensure は OpencodeDisabledError で断る。 */
  serves: ServeManager;
  /** 新しいセッションの選択肢（モードとモデル）。取った一覧を場所ごとに手元に持つ。 */
  options: OpencodeOptionsService;
  /** 設定のプロバイダー（つないだ先、API キー、ログイン、OpenAI 互換のサーバー）。変えたら options を取り直させる。 */
  providers: OpencodeProvidersService;
  /** 同期で上げる本文の書き出し（`opencode session export`）。会話の serve が起きていればそれにつなぐ。 */
  exporter: OpencodeExporter;
  /** ほかの PC の会話の取り込み（`session import`）と、引き継ぎの前の作業の止め（interrupt と idle 待ち）。会話の serve につなぐ。 */
  transfer: OpencodeTransfer;
  /** 起動のときの掃除が済むと解決する。 */
  swept: Promise<unknown>;
  /** 最後に出た、範囲の外の版の知らせの種。画面へは起こすたびに onVersionNotice で配る（C7）。 */
  versionNotice: () => OpencodeVersionNoticeSeed | null;
  /** hangar の終わりの後片付け。動いている run の会話の serve は残し、ほかを止める。上限を過ぎたら待たずに返す。 */
  stop: (ms: number) => Promise<void>;
};

/** この PC で動いている opencode の run の、hangar の会話の ID。 */
function aliveOpencodeSessions(db: Db | undefined, deviceId: string | undefined): Set<string> {
  if (!db || !deviceId) return new Set();
  const providerOf = db.prepare('select provider from sessions where id = ?');
  return new Set(listAliveRuns(db, deviceId)
    .filter((r) => (providerOf.get(r.sessionId) as { provider: string } | undefined)?.provider === 'opencode')
    .map((r) => r.sessionId));
}

/**
 * opencode（ベータ）の serve の管理を組む。
 * 前の hangar が残した serve は、動いている run の会話のものを引き継ぎ（hangar を閉じても会話は続く）、ほかを止める。
 * この掃除だけは、設定の入り切りに関わらず起動のときに回す（切にしたあとで落ちた回の残りを止めるため）。
 * 設定が切なら、ほかには何も起こさない。
 * Windows は、tmux（psmux）があれば serve を画面の中で起こす（serve/pane.ts）。直に起こすと、hangar のサーバの終わりに道連れになるからである。
 */
export function bootOpencode(
  p: { home: string; settings: { current: Pick<Settings, 'opencodeEnabled'> }; db?: Db; device?: { id: string } },
  o: {
    bin?: () => string | null;
    version?: () => Promise<string | null>;
    /** 範囲の外の版で serve を起こすたびに呼ぶ。server.ts が画面へ配る（右下の札の種、C7）。 */
    onVersionNotice?: (seed: OpencodeVersionNoticeSeed) => void;
    /** いまの画面の口（tmux、Windows は psmux）。serve を画面の中で起こすときと、残った serve の画面を閉じるときに使う。 */
    panes?: () => PaneOps | null;
    /** serve を画面の中で起こすか。既定は Windows だけ。 */
    serveInPane?: boolean;
  } = {},
): OpencodeParts {
  const bin = o.bin ?? (() => findOpencode());
  const local = new LocalOpencode({ bin });
  const registry = new ServeRegistry(serveRegistryPath(p.home));
  const log = (line: string): void => { console.log(line); };
  const panes = o.panes ?? (() => null);
  const host: PaneServeHost = { panes, node: process.execPath, wrapper: () => ensureServeWrapper(p.home), dir: path.join(p.home, 'opencode', 'panes') };
  const disposePane = (name: string): void => disposeServePane(host, name);
  const alive = (): Set<string> => aliveOpencodeSessions(p.db, p.device?.id);
  // 動いている run の会話の serve を引き継ぐ。記録の pid は 1 回だけまとめて見る（Windows は PowerShell が遅い）。
  const rows = registry.list();
  const probe = rows.length > 0 ? defaultProbe(rows.map((r) => r.pid)) : undefined;
  const keepIds = rows.length > 0 ? alive() : new Set<string>();
  const adoptable = adoptableServes(registry, (id) => keepIds.has(id), probe);
  const swept = sweepLeftoverServes(registry, { log, probe, keep: new Set(adoptable.map((r) => r.pid)), closePane: disposePane }).catch((e: unknown) => {
    console.warn(`[opencode] could not sweep leftover serve processes: ${(e as Error).message}`);
  });
  const inPane = o.serveInPane ?? process.platform === 'win32';
  // 画面が使えないとき（tmux の設定が無い）は直に起こす。
  const start: ServeStarter = (x) => (inPane && panes() ? startServeInPane({ ...x, host }) : startServe(x));
  let notice: OpencodeVersionNoticeSeed | null = null;
  const serves = new ServeManager({
    enabled: () => opencodeEnabledOf(p.settings.current),
    bin,
    version: o.version ?? (async () => (await local.status()).version),
    registry,
    ready: swept,
    log,
    onVersionNotice: (seed) => { notice = seed; o.onVersionNotice?.(seed); },
    secrets: serveSecrets(p.home),
    start,
    disposePane,
  });
  serves.adopt(adoptable);
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
  const transfer = new OpencodeTransfer({ bin, serves });
  return {
    serves,
    options,
    providers,
    exporter,
    transfer,
    swept,
    versionNotice: () => notice,
    stop: async (ms) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        providers.close().then(() => {
          const keep = alive();
          return serves.stopAll({ keep: (id) => keep.has(id) });
        }),
        new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    },
  };
}
