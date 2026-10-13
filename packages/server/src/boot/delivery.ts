import type { NoticeEvent } from '../events/publisher.ts';
import { Publisher } from '../events/publisher.ts';
import { AsideReader } from '../live/aside.ts';
import { LiveDigester } from '../live/digest.ts';
import { CompatLog, compatPath } from '../provider/claude-code/compat/log.ts';
import { RegistryWatcher, watchDir } from '../provider/claude-code/registry.ts';
import { PermissionAsks } from '../sessions/permissionAsks.ts';
import { OsNoticeFeed } from '../sessions/stopNotices.ts';
import { toastVia, type Toast } from '../sync/notices.ts';
import { EventHub } from '../ws/hub.ts';
import type { HomeParts } from './home.ts';
import { VERSION, type StartOptions } from './options.ts';

/** 作業中があるか、登録のディレクトリを見張れない間の、登録の読み直しの間隔。 */
export const REGISTRY_POLL_MS = 500;
/**
 * 見張れていて作業中が 1 つも無い間の、登録の読み直しの間隔。
 * 変化は見張りの知らせで拾うので、この周期が拾うのは、Windows で止められた claude の pid が消えたこと（登録が残る）と、見張りの取りこぼしである。
 */
export const REGISTRY_IDLE_MS = 2000;

export type DeliveryParts = {
  /** WebSocket の束。ここへ直に配る箇所は無い。配るのは publisher である。 */
  sockets: EventHub;
  publisher: Publisher;
  /**
   * 画面へ知らせを渡す口。中身は publisher である。
   * 行のイベント（session.upsert など）は、ここからは渡せない（NoticeEvent）。行を書くか、touchRow で名指しする。
   */
  hub: { broadcast(ev: NoticeEvent): void };
  toast: Toast;
  /** Claude Code の形式のずれの記録（provider/claude-code/compat/）。端末ごとのファイルで、同期しない。 */
  compatLog: CompatLog;
  /** 手元の claude の版。listen の後に裏で読む。読めるまでは null で、版の無いずれを null で記録する。 */
  claudeVersion: { current: string | null };
  /** 右ペインの要約器。裏の印と HTTP（UI の取り直し）で 1 つの覚えを共有する。別々に持つと、長いセッションの同じ要約を二度作る。 */
  digester: LiveDigester;
  /** 実行中の一覧（Claude の登録の見張り）。作るだけで、読み始めるのは起動の手続きの中である。 */
  registry: RegistryWatcher;
  /** hook から届いた許可の確認（sessions/permissionAsks.ts）。登録の読み直しのたびに、入力待ちの登録へ中身を足す。 */
  permissionAsks: PermissionAsks;
  /** デスクトップ通知の並び（sessions/stopNotices.ts）。書くのは知らせの見張り（boot/runs.ts）、読むのは殻（GET /api/notify/feed）。 */
  osNotices: OsNoticeFeed;
  /** 溜まっている知らせを出し切ってから配る層を止め、WebSocket を畳む。止めた後は DB を読みに行かない。 */
  stopPublishing(): Promise<void>;
};

/**
 * 画面へ配る層と、実行中の一覧を組む。
 *
 * 配る層は 1 つである。DB の行の変化はここが DTO に組み直して配り、明示の知らせ（トーストなど）もここを通って同じ順に届く。
 * 受け手がいないあいだは行を読み直さない。起動時の全走査で、誰も受けない DTO を組まないためである。
 * 索引も同期も run も、行を書けばここが配る。だから、これらより先に組む。
 */
export function bootDelivery(home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir'>, opts: Pick<StartOptions, 'registryIsGone'> = {}): DeliveryParts {
  const { db } = home;
  const sockets = new EventHub(VERSION);
  const publisher = new Publisher({ db, deviceId: home.device.id, live: () => registry.current(), hub: sockets, active: () => sockets.clientCount() > 0 });
  const claudeVersion: { current: string | null } = { current: null };
  const compatLog = new CompatLog({ file: compatPath(home.home), localVersion: () => claudeVersion.current });
  compatLog.start();
  // 裏でサブエージェントだけが動いているものに、読み直しのたびに印を足す（live/aside.ts）。
  // 右ペインの要約は、裏の印と HTTP（UI の取り直し）で 1 つの覚えを共有する。別々に持つと、長いセッションの同じ要約を二度作る。
  const digester = new LiveDigester(db);
  const aside = new AsideReader(db, digester);
  // 許可待ちの中身（道具と命令）は hook から届く。読み直しのたびに、入力待ちの登録へ足す。
  // 届いたら、登録の読み直しを待たずに足させる（待機中の読み直しは間が空く）。
  const permissionAsks = new PermissionAsks(() => registry.kick(0));
  const osNotices = new OsNoticeFeed();
  // 登録のディレクトリを見張り、見張れていて作業中が無い間は REGISTRY_IDLE_MS ごとにしか読まない（provider/claude-code/registry.ts）。
  const registry = new RegistryWatcher(home.claudeDir, REGISTRY_POLL_MS, opts.registryIsGone, (live) => { const now = Date.now(); return permissionAsks.apply(aside.apply(live, now), now); }, compatLog, { idleMs: REGISTRY_IDLE_MS, watch: watchDir });
  return {
    sockets, publisher, hub: publisher, toast: toastVia(publisher), compatLog, claudeVersion, registry, digester, permissionAsks, osNotices,
    stopPublishing: async () => {
      // 殻の長いポーリングを先に返す。開いたままの要求が、待ち受けを閉じるのを遅らせないためである。
      osNotices.close();
      publisher.flush();
      publisher.stop();
      await sockets.close();
    },
  };
}
