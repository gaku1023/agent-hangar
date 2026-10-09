import type { NoticeEvent } from '../events/publisher.ts';
import { Publisher } from '../events/publisher.ts';
import { AsideReader } from '../live/aside.ts';
import { CompatLog, compatPath } from '../provider/claude-code/compat/log.ts';
import { RegistryWatcher } from '../provider/claude-code/registry.ts';
import { toastVia, type Toast } from '../sync/notices.ts';
import { EventHub } from '../ws/hub.ts';
import type { HomeParts } from './home.ts';
import { VERSION, type StartOptions } from './options.ts';

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
  /** 実行中の一覧（Claude の登録の見張り）。作るだけで、読み始めるのは起動の手続きの中である。 */
  registry: RegistryWatcher;
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
  const aside = new AsideReader(db);
  const registry = new RegistryWatcher(home.claudeDir, undefined, opts.registryIsGone, (live) => aside.apply(live, Date.now()), compatLog);
  return {
    sockets, publisher, hub: publisher, toast: toastVia(publisher), compatLog, claudeVersion, registry,
    stopPublishing: async () => {
      publisher.flush();
      publisher.stop();
      await sockets.close();
    },
  };
}
