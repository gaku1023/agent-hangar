import { orchestratorLineage, orchestratorOf } from '@agent-hangar/shared';
import type { NoticeEvent } from '../events/publisher.ts';
import { Publisher } from '../events/publisher.ts';
import { AsideReader } from '../live/aside.ts';
import { markOrchestrator } from '../live/orchestratorRole.ts';
import { setOrchestratorSource } from '../db/queries.ts';
import { orchestratorIdsSource } from '../orchestrator/peerLineage.ts';
import { LiveDigester } from '../live/digest.ts';
import { LiveHub } from '../agent/liveHub.ts';
import { FolderTrustLive } from '../runs/folderTrust.ts';
import { CompatLog, compatPath } from '../provider/claude-code/compat/log.ts';
import { routeAgentAsk } from '../sessions/agentAsks.ts';
import { HookDecisions } from '../sessions/hookDecisions.ts';
import { PermissionAsks } from '../sessions/permissionAsks.ts';
import { OsNoticeFeed } from '../sessions/stopNotices.ts';
import { toastVia, type Toast } from '../sync/notices.ts';
import { EventHub } from '../ws/hub.ts';
import { bootAgents, type AgentParts } from './agents.ts';
import type { HomeParts } from './home.ts';
import { VERSION, type StartOptions } from './options.ts';

export type DeliveryParts = AgentParts & {
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
  /**
   * 実行中の一覧。エージェントごとの driver の写し（Claude の登録の見張りと、opencode の serve の出来事の流れ）を束ねる（agent/liveHub.ts）。
   * 作るだけで、読み始めるのは起動の手続きの中である。
   */
  live: LiveHub;
  /** 会話の前に出るフォルダの信頼の確認を、入力待ちの行として実行中の一覧へ載せる写し（runs/folderTrust.ts）。見張りは RunManager が持つ。 */
  folderTrust: FolderTrustLive;
  /** hook から届いた許可の確認（sessions/permissionAsks.ts）。登録の読み直しのたびに、入力待ちの登録へ中身を足す。 */
  permissionAsks: PermissionAsks;
  /** 許可の確認の同期の hook が答えを待つ表（sessions/hookDecisions.ts）。札に答える手（peer/chat）が決め、台本が受け取る。 */
  hookDecisions: HookDecisions;
  /** デスクトップ通知の並び（sessions/stopNotices.ts）。書くのは知らせの見張り（boot/runs.ts）、読むのは殻（GET /api/notify/feed）。 */
  osNotices: OsNoticeFeed;
  /** 溜まっている知らせを出し切ってから配る層を止め、WebSocket を畳む。止めた後は DB を読みに行かない。 */
  stopPublishing(): Promise<void>;
};

/**
 * 画面へ配る層と、実行中の一覧と、エージェントの driver を組む。
 *
 * 配る層は 1 つである。DB の行の変化はここが DTO に組み直して配り、明示の知らせ（トーストなど）もここを通って同じ順に届く。
 * 受け手がいないあいだは行を読み直さない。起動時の全走査で、誰も受けない DTO を組まないためである。
 * 索引も同期も run も、行を書けばここが配る。だから、これらより先に組む。
 */
export function bootDelivery(home: Pick<HomeParts, 'home' | 'db' | 'device' | 'claudeDir' | 'token' | 'settings' | 'language'>, opts: Pick<StartOptions, 'registryIsGone'> = {}): DeliveryParts {
  const { db } = home;
  const sockets = new EventHub(VERSION);
  const publisher = new Publisher({ db, deviceId: home.device.id, live: () => live.current(), hub: sockets, active: () => sockets.clientCount() > 0, counts: true });
  const claudeVersion: { current: string | null } = { current: null };
  const compatLog = new CompatLog({ file: compatPath(home.home), localVersion: () => claudeVersion.current });
  compatLog.start();
  // 裏でサブエージェントだけが動いているものに、読み直しのたびに印を足す（live/aside.ts）。
  // 右ペインの要約は、裏の印と HTTP（UI の取り直し）で 1 つの覚えを共有する。別々に持つと、長いセッションの同じ要約を二度作る。
  const digester = new LiveDigester(db);
  const aside = new AsideReader(db, digester);
  // 許可待ちの中身（道具と命令）は hook から届く。読み直しのたびに、入力待ちの登録へ足す。
  // 届いたら、登録の読み直しを待たずに足させる（待機中の読み直しは間が空く）。
  const permissionAsks = new PermissionAsks(() => live.kick(0));
  // 同期の hook が答えを待つ表。登録が許可の待ちを抜けたり、会話が一覧から消えたりしたら、待ちを閉じる。
  const hookDecisions = new HookDecisions({ onOpen: () => live.kick(0) });
  const osNotices = new OsNoticeFeed();
  // 実行中の一覧。足し付けの鎖（裏だけの印、許可の中身の順）は束ねる側が持ち、各 driver の写しが読み直しのたびに通す。
  // 統括の会話には role を足す（live/orchestratorRole.ts）。role は設定の orchestrator.sessionId から導き、一覧の DTO（db/queries.ts）も同じ設定を見る。
  const orchestratorId = (): string | null => home.settings.current.orchestrator?.sessionId ?? null;
  // 一覧の DTO は系譜の全部（前の統括の会話もサイドバーに出さない）、実行中の一覧は今の 1 本だけに付ける。
  // 一覧の DTO には、ほかの PC が宿主の統括の系譜（その PC の devices の行の様子）も合わせる。統括の設定は同期しないためである（orchestrator/peerLineage.ts）。
  setOrchestratorSource(db, orchestratorIdsSource(db, home.device.id, () => orchestratorLineage(orchestratorOf(home.settings.current.orchestrator))));
  const markRole = markOrchestrator(db, orchestratorId);
  const live = new LiveHub({ enrich: [(l, now) => aside.apply(l, now), (l, now) => permissionAsks.apply(l, now), (l, now) => { hookDecisions.apply(l, now); return l; }, (l) => markRole(l)] });
  const agents = bootAgents(home, { compatLog, claudeVersion, enrich: (l) => live.enrich(l), registryIsGone: opts.registryIsGone });
  live.add(agents.claude.live);
  // 信頼の確認の行。claude の登録より後に足す（同じ会話の登録の行が現れたら、LiveHub がこちらを捨てる）。
  const folderTrust = new FolderTrustLive();
  // opencode の写し（serve の出来事の流れ）。会話を起こすまで行は無い。
  live.add(agents.opencode.live);
  // opencode は hook を持たないので、許可と問いは流れから受け、hook の受け口と同じ書き手で書く（sessions/agentAsks.ts）。
  // 起動後にモデルの長さが足りずに断られたら、右下の札で知らせる（「整えて再開」）。
  agents.opencode.contextShort((sessionId) => { publisher.broadcast({ type: 'opencode.contextShort', sessionId }); });
  // 起動後に、この PC に無いモデルで断られたら、右下の札で知らせる（「別のモデルでやり直す」）。
  agents.opencode.modelMissing((sessionId, model) => { publisher.broadcast({ type: 'opencode.modelMissing', sessionId, model }); });
  // Codex の写し（app-server の通知）。起こした会話だけが載る。許可と問いは opencode と同じ書き手で書く。
  live.add(agents.codex.live);
  live.add(folderTrust);
  agents.codex.asks.subscribe?.((a) => { routeAgentAsk(db, agents.codex.kind, a, permissionAsks, Date.now()); });
  agents.opencode.asks.subscribe?.((a) => { routeAgentAsk(db, agents.opencode.kind, a, permissionAsks, Date.now()); });
  return {
    ...agents,
    sockets, publisher, hub: publisher, toast: toastVia(publisher), compatLog, claudeVersion, live, folderTrust, digester, permissionAsks, hookDecisions, osNotices,
    stopPublishing: async () => {
      // 殻の長いポーリングを先に返す。開いたままの要求が、待ち受けを閉じるのを遅らせないためである。
      osNotices.close();
      publisher.flush();
      publisher.stop();
      await sockets.close();
    },
  };
}
