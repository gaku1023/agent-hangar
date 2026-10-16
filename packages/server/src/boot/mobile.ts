import type { AccountsDto, CloudDevicesDto, MobileLaunchOut } from '@agent-hangar/shared';
import type { AccountStore } from '../config/accounts.ts';
import type { Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { onIntent } from '../live/intents.ts';
import { buildMobileFeed } from '../mobile/feed.ts';
import { MobileLaunchInbox } from '../mobile/launchInbox.ts';
import { FEED_SAFETY_MS, MobileFeedPublisher } from '../mobile/publisher.ts';
import type { RegistryWatcher } from '../provider/claude-code/registry.ts';
import type { RunManager } from '../runs/manager.ts';
import type { CloudClient } from '../sync/client.ts';
import type { SyncEngine, Timers } from '../sync/engine.ts';
import type { UsageTracker } from '../usage/statusline.ts';
import type { SyncParts } from './sync.ts';

/**
 * 変わったら受信箱の素を組み直すきっかけにする表。
 * 素が読むのは、会話（sessions、session_notes）、状態（session_states）、要約の 1 行（session_summaries）、run（runs）、プロジェクトとこの PC の場所（projects、project_roots）である。
 * 中身が変わらなければ書かない（ハッシュで比べる）ので、多めに拾っても書き込みは増えない。
 */
export const FEED_TABLES: ReadonlySet<string> = new Set(['sessions', 'session_states', 'session_summaries', 'runs', 'project_roots', 'projects', 'session_notes']);

/**
 * 答えを送れなかった起動の依頼を送り直す見回りの間隔（mobile/launchInbox.ts の resendAnswers）。
 * スマホは 80 秒で待つのをやめるので、pull の 30 秒より短くする。見るのは手元の表だけで、送るものが無ければ Worker に要求を出さない。
 */
export const ANSWER_RESEND_TICK_MS = 10_000;

/**
 * スマホがつながっているかを、Worker の一覧（GET /devices）で読み直す間隔。
 * 一覧が分からないあいだは、見回り（FEED_SAFETY_MS）のたびに読む。
 * この PC の設定の画面で QR を出している間は、画面が 3 秒ごとに読むので、つながったことはすぐ届く。
 */
export const PHONE_RECHECK_MS = 5 * 60_000;

export type MobileParts = {
  /** 今の受信箱の素の書き手。同期を設定していない、または止めた後は null。 */
  publisher(): MobileFeedPublisher | null;
  /** きっかけの購読と見回りを始め、書き手を組めるなら組んで最初の 1 回を予約する。同期より後に呼ぶ。 */
  start(): void;
  /** 購読と見回りを外し、書き手を止める。走っている書き込みは待たない。 */
  stop(): void;
};

type Link = { client: CloudClient; joinSecret: string };

/**
 * スマホの受信箱に預ける素（mobile/feed.ts）を、封じて Worker に書く仕事を組む（mobile/publisher.ts）。
 *
 * きっかけは、実行中の一覧の変化、意図の書き込み、受信箱に関わる表の変化、アカウントの配り（使用率の更新を含む）、
 * run の画面から Remote Control の URL を拾ったこと（run_remote_urls は同期の表でないので行の変化が届かない）、書き手の 60 秒の安全網である。
 * 使用率の更新には専用の口が無いので、画面へアカウントを配る口（accounts.broadcast）を包んで拾う。止めると元に戻す。
 * 書いてよいのは、同期の canCarryMobile が真（Worker の版 7 から、止まっていないとき）で、外していないスマホが 1 台以上あるときだけである。
 * スマホの有無は同期の cloudDevices が読んだ一覧で知る（設定の画面の読み込みと、PHONE_RECHECK_MS ごとの見回り）。
 * 一覧が分からないあいだは書かない。スマホが 1 台も無い PC は、Worker に受信箱の素を 1 行も書かない。
 * 最初のスマホが現れたら、前に書いた中身を忘れてすぐ書く（外していた間に同じ中身のままでも置き直す）。
 * client と参加の秘密は同期から引き、cloud.json を後から拾って組み直したときは書き手も組み直す。
 * どのきっかけも投げない。購読の先（同期の輪、登録の読み直し、MCP の道具）へ失敗を返さない。
 *
 * スマホからの起動の依頼（mobile/launchInbox.ts）も、書き手の隣に組む。依頼は同期の engine の pull で届く（launches）。
 * engine は cloud.json を拾い直すと別のものになるので、見回りときっかけのたびに今の engine を購読し直す。
 * 依頼を扱うのも canCarryMobile が真のときだけで、版 6 の Worker には claim を送らない。
 * 起こせたら書き手を nudge し、スマホの受信箱に新しい会話を早く出す。
 * 答えを送れなかった依頼は、ANSWER_RESEND_TICK_MS ごとの見回りで送り直す。
 */
export function bootMobile(p: {
  home: { db: Db; device: { id: string; name: string } };
  delivery: { registry: Pick<RegistryWatcher, 'current' | 'onChange'> };
  runs: { runs: Pick<RunManager, 'start' | 'on'>; accounts: { store: Pick<AccountStore, 'list'>; usage: Pick<UsageTracker, 'of'>; broadcast: (accounts: AccountsDto) => void } };
  /** engine は組み直すと変わる（boot/sync.ts の getter）。毎回引き直す。 */
  sync: Pick<SyncParts, 'canCarryMobile' | 'mobileLink' | 'cloudDevices' | 'onCloudDevices'> & { readonly engine: Pick<SyncEngine, 'on'> };
  timers?: Timers;
  now?: () => number;
}): MobileParts {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const timers: Timers = p.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const accounts = p.runs.accounts;
  let cur: { pub: MobileFeedPublisher; inbox: MobileLaunchInbox; link: Link } | null = null;
  /** 今購読している engine と、その解除。 */
  let sub: { engine: Pick<SyncEngine, 'on'>; off: () => void } | null = null;
  const placeHere = db.prepare('select 1 from project_roots r join projects p on p.id = r.project_id where r.project_id = ? and r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0');
  let started = false;
  let stopped = false;
  const offs: (() => void)[] = [];
  let sweep: ReturnType<typeof setInterval> | null = null;
  let resend: ReturnType<typeof setInterval> | null = null;
  const now = p.now ?? Date.now;
  /** 外していないスマホがあるか。null は分からない（まだ読めていない、同期していない）。 */
  let phones: boolean | null = null;
  let phonesAt: number | null = null;
  let checking = false;

  const build = () => buildMobileFeed({
    db, deviceId, deviceName: p.home.device.name,
    live: p.delivery.registry.current(),
    accounts: accounts.store.list(),
    usageOf: (id) => accounts.usage.of(id),
    now: Date.now(),
  });

  /** 今の engine を購読する。組み直されていたら前の購読を外す。 */
  const follow = (): void => {
    const engine = p.sync.engine;
    if (sub?.engine === engine) return;
    sub?.off();
    sub = null;
    sub = { engine, off: engine.on({ launches: (l) => { onLaunches(l); } }) };
  };
  /** 今の同期の client と秘密に合う書き手を返す。変わっていたら前のを止めて組み直す。 */
  const ensure = (): MobileFeedPublisher | null => {
    if (!started || stopped) return null;
    follow();
    const link = p.sync.mobileLink();
    if (cur && link && cur.link.client === link.client && cur.link.joinSecret === link.joinSecret) return cur.pub;
    cur?.pub.stop();
    cur = null;
    if (!link) return null;
    const pub = new MobileFeedPublisher({ build, client: link.client, joinSecret: link.joinSecret, deviceId, timers, now, canWrite: () => phones === true && p.sync.canCarryMobile() });
    const inbox = new MobileLaunchInbox({
      db, client: link.client, joinSecret: link.joinSecret, deviceId,
      start: (params) => {
        const r = p.runs.runs.start(params);
        kick();
        return r;
      },
      hasProjectHere: (projectId) => !!placeHere.get(projectId, deviceId),
      hasAccount: (id) => accounts.store.list().some((a) => a.id === id),
      canProcess: () => p.sync.canCarryMobile(),
      now: Date.now,
    });
    cur = { pub, inbox, link };
    pub.start();
    return pub;
  };
  const kick = (): void => {
    try { ensure()?.nudge(); } catch (e) { console.error('[mobile] could not schedule the mobile feed', e instanceof Error ? e.constructor.name : typeof e); }
    checkPhones();
  };
  /**
   * 読めた一覧からスマホの有無を覚える。
   * 読めない（unreachable）ときは前の値のままにし、同期していない、この PC が外された（off、revoked）ときは分からないに戻す。
   * 一覧の口を持たない古い Worker（outdated）にはスマホがつながらない。
   */
  function notePhones(d: CloudDevicesDto): void {
    if (stopped) return;
    if (d.state === 'unreachable') return;
    phonesAt = now();
    const next = d.state === 'ok' ? d.devices.some((x) => x.kind === 'mobile' && x.revokedAt === null) : d.state === 'outdated' ? false : null;
    const appeared = next === true && phones !== true;
    phones = next;
    if (!appeared) return;
    cur?.pub.forget();
    kick();
  }
  /** スマホの有無を読み直す時期なら、一覧を読みに行く。読めた一覧は onCloudDevices で notePhones に届く。投げない。 */
  function checkPhones(): void {
    try {
      if (!started || stopped || checking || !p.sync.canCarryMobile()) return;
      // 分からないあいだは見回りの間隔で、分かった後は PHONE_RECHECK_MS ごとに読む。きっかけが続いても、それより詰めない。
      const gap = phones === null ? FEED_SAFETY_MS : PHONE_RECHECK_MS;
      if (phonesAt !== null && now() - phonesAt < gap) return;
      checking = true;
      phonesAt = now();
      p.sync.cloudDevices()
        .catch((e: unknown) => { console.error('[mobile] could not read the device list', e instanceof Error ? e.constructor.name : typeof e); })
        .finally(() => { checking = false; });
    } catch (e) {
      checking = false;
      console.error('[mobile] could not read the device list', e instanceof Error ? e.constructor.name : typeof e);
    }
  }
  /** pull で届いた依頼を受け手へ渡す。投げない（engine の pull へ失敗を返さない）。 */
  function onLaunches(l: MobileLaunchOut[]): void {
    try {
      if (!p.sync.canCarryMobile()) return;
      ensure();
      void cur?.inbox.receive(l).catch((e: unknown) => console.error('[mobile] could not handle the launch requests', e instanceof Error ? e.constructor.name : typeof e));
    } catch (e) {
      console.error('[mobile] could not handle the launch requests', e instanceof Error ? e.constructor.name : typeof e);
    }
  }

  const original = accounts.broadcast;
  const wrapped = (dto: AccountsDto): void => {
    try { original(dto); } finally { kick(); }
  };

  return {
    publisher: () => cur?.pub ?? null,
    start() {
      if (started || stopped) return;
      started = true;
      offs.push(p.delivery.registry.onChange(() => kick()));
      offs.push(onIntent(() => kick()));
      offs.push(p.runs.runs.on({ remoteUrl: () => kick() }));
      offs.push(onRowChange((c) => { if (c.db === db && FEED_TABLES.has(c.table)) kick(); }));
      offs.push(p.sync.onCloudDevices(notePhones));
      accounts.broadcast = wrapped;
      offs.push(() => { if (accounts.broadcast === wrapped) accounts.broadcast = original; });
      // 起動のときに同期が無かった端末で、cloud.json が後から現れたのを拾う見回り。書き手が居れば何もしない。
      sweep = timers.setInterval(() => {
        try { ensure(); } catch (e) { console.error('[mobile] could not set up the mobile feed', e instanceof Error ? e.constructor.name : typeof e); }
        checkPhones();
      }, FEED_SAFETY_MS);
      sweep.unref?.();
      resend = timers.setInterval(() => {
        if (!cur || !p.sync.canCarryMobile()) return;
        void cur.inbox.resendAnswers().catch((e: unknown) => console.error('[mobile] could not resend the launch answers', e instanceof Error ? e.constructor.name : typeof e));
      }, ANSWER_RESEND_TICK_MS);
      resend.unref?.();
      // 起動の途中で投げると、サーバの起動そのものが倒れる。kick と同じく拾ってログに残し、見回りで組み直す。
      try { ensure(); } catch (e) { console.error('[mobile] could not set up the mobile feed', e instanceof Error ? e.constructor.name : typeof e); }
      checkPhones();
    },
    stop() {
      stopped = true;
      for (const off of offs.splice(0)) off();
      if (sweep) timers.clearInterval(sweep);
      if (resend) timers.clearInterval(resend);
      sweep = resend = null;
      sub?.off();
      sub = null;
      cur?.pub.stop();
      cur = null;
    },
  };
}
