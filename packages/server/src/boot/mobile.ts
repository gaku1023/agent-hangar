import path from 'node:path';
import type WebSocket from 'ws';
import { MOBILE_BELL_MIN_WORKER_COMPAT, opencodeEnabledOf, type AccountsDto, type CloudDevicesDto, type MobileLaunchOut, type ServerEvent } from '@agent-hangar/shared';
import type { AccountStore } from '../config/accounts.ts';
import type { Settings } from '../config/paths.ts';
import type { Db } from '../db/open.ts';
import { onRowChange } from '../db/notify.ts';
import { onIntent } from '../live/intents.ts';
import { answerAsk } from '../mobile/asks.ts';
import { MobileBell } from '../mobile/bell.ts';
import { buildMobileFeed } from '../mobile/feed.ts';
import { MobileLaunchInbox, type PhoneLaunchStarted } from '../mobile/launchInbox.ts';
import { FEED_SAFETY_MS, MobileFeedPublisher } from '../mobile/publisher.ts';
import type { LiveHub } from '../agent/liveHub.ts';
import { findOpencode } from '../config/tools.ts';
import type { OpencodeOptionsService } from '../provider/opencode/options.ts';
import type { RunManager } from '../runs/manager.ts';
import type { BellTarget, CloudClient } from '../sync/client.ts';
import type { SyncEngine, Timers } from '../sync/engine.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';
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
/** 起動の依頼の送り手が名簿に無いとき、同じ ID で一覧を読み直す最小の間隔。 */
export const PHONE_NAME_REREAD_MS = 10_000;

export type MobileParts = {
  /** 今の受信箱の素の書き手。同期を設定していない、または止めた後は null。 */
  publisher(): MobileFeedPublisher | null;
  /** きっかけの購読と見回りを始め、書き手を組めるなら組んで最初の 1 回を予約する。同期より後に呼ぶ。 */
  start(): void;
  /** 購読と見回りを外し、書き手を止める。走っている書き込みは待たない。 */
  stop(): void;
  /**
   * 素の中身に効く設定が変わった（opencode の入り切り。素の caps と opencode の行が変わる）。組み直しを予約する。
   * 設定は DB の行ではないので、表の変化の購読（FEED_TABLES）では拾えない。start の前と stop の後は何もしない。
   */
  settingsChanged(): void;
};

type Link = { client: CloudClient; phoneKeys: PhoneKeySource };

/**
 * スマホの受信箱に預ける素（mobile/feed.ts）を、封じて Worker に書く仕事を組む（mobile/publisher.ts）。
 *
 * きっかけは、実行中の一覧の変化、意図の書き込み、受信箱に関わる表の変化、アカウントの配り（使用率の更新を含む）、
 * run の画面から Remote Control の URL を拾ったこと（run_remote_urls は同期の表でないので行の変化が届かない）、書き手の 60 秒の安全網である。
 * 使用率の更新には専用の口が無いので、画面へアカウントを配る口（accounts.broadcast）を包んで拾う。止めると元に戻す。
 * 書いてよいのは、同期の canCarryMobile が真（Worker の版 7 から、止まっていないとき）で、外していないスマホが 1 台以上あるときだけである。
 * スマホの有無は同期の cloudDevices が読んだ一覧で知る（設定の画面の読み込みと、PHONE_RECHECK_MS ごとの見回り）。
 * 一覧が分からないあいだは書かない。スマホが 1 台も無い PC は、Worker に受信箱の素を 1 行も書かない。
 * 要対応に新しく入った会話のスマホへの通知（POST /notices）も、書き手が素を書いたあとに送る。送るかどうかのスマホの有無も、同じ一覧で渡す。
 * 最初のスマホが現れたら、前に書いた中身を忘れてすぐ書く（外していた間に同じ中身のままでも置き直す）。
 * 外していないスマホが居るのを見た後で、読めた一覧にそれが無くなったら、Worker の受信箱の素を消す（DELETE /m/feed、書き手の dropFeed）。
 * 消せなければ、次の読み直しでやり直す。つなぎ先（cloud.json）が替わったら、スマホの有無の覚えを捨て、5 分を待たずに読み直す。
 * client とスマホ用の鍵の引き口（名簿の phoneKey）は同期から引き、cloud.json を後から拾って組み直したときは書き手も組み直す。
 * スマホ用の鍵がまだ無い（スマホを接続していない）あいだ、書き手は何も書かない。
 * どのきっかけも投げない。購読の先（同期の輪、登録の読み直し、MCP の道具）へ失敗を返さない。
 *
 * スマホからの起動の依頼（mobile/launchInbox.ts）も、書き手の隣に組む。依頼は同期の engine の pull で届く（launches）。
 * engine は cloud.json を拾い直すと別のものになるので、見回りときっかけのたびに今の engine を購読し直す。
 * 依頼を扱うのも canCarryMobile が真のときだけで、版 6 の Worker には claim を送らない。
 * 依頼の effort と画像（drops に置いてパスを指示の末尾に足す）も受け取る。画像の置き場は hangar の home の下の drops である。
 * 起こせたら書き手を nudge し、スマホの受信箱に新しい会話を早く出す。
 * 画面には phone.launch を配り、右下に「〈スマホの名前〉から起動」の通知を出させる（試作 F1）。スマホの名前は読めた一覧（名簿）から引く。
 * 答えを送れなかった依頼は、ANSWER_RESEND_TICK_MS ごとの見回りで送り直す。
 *
 * Worker の呼び鈴（mobile/bell.ts）も、書き手と受け手の隣に組み、リンクが変わるたびに組み直す。
 * 張るのは、canCarryMobile が真で、Worker の名乗る版が MOBILE_BELL_MIN_WORKER_COMPAT に届き、外していないスマホが 1 台以上あるときだけである。
 * 鳴ったら（`{t:'launch'}`）今の engine の pullNow で依頼を受け取る。問い合わせ（`{t:'ask'}`）には mobile/asks.ts が答える。
 * 張るかどうかは、きっかけ、見回り、スマホの有無が分かったときに読み直す。
 * 呼び鈴が張れなくても、依頼は今までどおり 30 秒の pull で届く。
 */
export function bootMobile(p: {
  /** home は hangar の home（置き場 drops の親）。 */
  home: { db: Db; device: { id: string; name: string }; home: string; settings?: { readonly current: Pick<Settings, 'opencodeEnabled'> } };
  /** hub は画面への配り口。スマホから起こした会話の右下の通知（phone.launch、試作 F1）を配る。無ければ配らない。 */
  delivery: { live: Pick<LiveHub, 'current' | 'onChange'>; hub?: { broadcast(ev: Extract<ServerEvent, { type: 'phone.launch' }>): void } };
  runs: { runs: Pick<RunManager, 'start' | 'on'>; accounts: { store: Pick<AccountStore, 'list'>; usage: Pick<UsageTracker, 'of'>; broadcast: (accounts: AccountsDto) => void } };
  /** engine は組み直すと変わる（boot/sync.ts の getter）。毎回引き直す。 */
  sync: Pick<SyncParts, 'canCarryMobile' | 'mobileLink' | 'cloudDevices' | 'onCloudDevices'> & { readonly engine: Pick<SyncEngine, 'on' | 'pullNow'> };
  timers?: Timers;
  now?: () => number;
  /** 呼び鈴の WebSocket を作る口。既定は ws。 */
  bellConnect?: (t: BellTarget) => WebSocket;
  /**
   * opencode（ベータ）の選択肢。スマホの問い合わせ（モードとモデル、`/` の候補）に、手元に持った一覧（取りに行かない）で答える。
   * 省けば、スマホの opencode の問い合わせと起動の依頼を断る（agent-missing）。
   */
  opencode?: { options: Pick<OpencodeOptionsService, 'last' | 'lastCommands'> };
  /** opencode の置き場を探す口。既定は config/tools.ts の findOpencode。試験が差し替える。 */
  findOpencode?: () => string | null;
}): MobileParts {
  const { db } = p.home;
  const deviceId = p.home.device.id;
  const timers: Timers = p.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const accounts = p.runs.accounts;
  /** スマホから opencode を起こせるか。設定で有効にしてあり、手元に見つかること（RunManager の入口と同じ確かめ）。 */
  const opencodeOn = (): boolean => !!p.opencode && !!p.home.settings && opencodeEnabledOf(p.home.settings.current);
  const opencodeAsk = p.opencode
    ? { ready: opencodeOn, options: (dir: string | null) => p.opencode!.options.last(dir), commands: (dir: string | null) => p.opencode!.options.lastCommands(dir) }
    : undefined;
  let cur: { pub: MobileFeedPublisher; inbox: MobileLaunchInbox; bell: MobileBell; link: Link } | null = null;
  /** 今購読している engine と、その解除。 */
  let sub: { engine: Pick<SyncEngine, 'on'>; off: () => void } | null = null;
  const placeHere = db.prepare('select 1 from project_roots r join projects p on p.id = r.project_id where r.project_id = ? and r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0');
  /** 問い合わせの答えに使う、この PC のプロジェクトの根。起動の依頼（placeHere）と同じ行だけを見る。 */
  const rootHere = db.prepare('select r.path as path from project_roots r join projects p on p.id = r.project_id where r.project_id = ? and r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0');
  let started = false;
  let stopped = false;
  const offs: (() => void)[] = [];
  let sweep: ReturnType<typeof setInterval> | null = null;
  let resend: ReturnType<typeof setInterval> | null = null;
  const now = p.now ?? Date.now;
  /** 外していないスマホがあるか。null は分からない（まだ読めていない、同期していない）。 */
  let phones: boolean | null = null;
  let phonesAt: number | null = null;
  /** 外していないスマホが居るのを見たあとで、受信箱の素をまだ Worker から消していないか。真のあいだは、スマホが居なくなったと分かるたびに消しに行く。 */
  let hadPhones = false;
  let checking = false;
  /** 読めた一覧（名簿）のスマホの名前。ID から引く。右下の通知「〈スマホの名前〉から起動」に使う（試作 F1）。 */
  let phoneNames = new Map<string, string>();
  /** 知らないスマホの ID で一覧を最後に読み直した時刻。ID ごとに読み直しを間引く。 */
  const phoneRereadAt = new Map<string, number>();

  const build = () => buildMobileFeed({
    db, deviceId, deviceName: p.home.device.name,
    live: p.delivery.live.current(),
    accounts: accounts.store.list(),
    usageOf: (id) => accounts.usage.of(id),
    now: Date.now(),
    opencodeEnabled: p.home.settings ? opencodeEnabledOf(p.home.settings.current) : false,
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
    if (cur && link && cur.link.client === link.client && cur.link.phoneKeys === link.phoneKeys) return cur.pub;
    // つなぎ先が替わったら、前の先で読んだスマホの有無は当てにならない。覚えを捨て、次のきっかけで読み直す（5 分は待たない）。
    if (cur) { phones = null; phonesAt = null; hadPhones = false; }
    cur?.pub.stop();
    cur?.bell.stop();
    cur = null;
    if (!link) return null;
    const pub = new MobileFeedPublisher({ build, client: link.client, phoneKeys: link.phoneKeys, deviceId, timers, now, canWrite: () => phones === true && p.sync.canCarryMobile(), hasPhones: () => phones === true });
    const inbox = new MobileLaunchInbox({
      db, client: link.client, phoneKeys: link.phoneKeys, deviceId,
      dropsDir: path.join(p.home.home, 'drops'),
      start: async (params) => {
        const r = await p.runs.runs.start(params);
        kick();
        return r;
      },
      hasProjectHere: (projectId) => !!placeHere.get(projectId, deviceId),
      hasAccount: (id) => accounts.store.list().some((a) => a.id === id),
      hasAgent: (agent) => agent === 'opencode' && opencodeOn() && (p.findOpencode ?? findOpencode)() !== null,
      canProcess: () => p.sync.canCarryMobile(),
      now: Date.now,
      onStarted: (e) => { void announceLaunch(e).catch((err: unknown) => console.error('[mobile] could not announce the started session', err instanceof Error ? err.constructor.name : typeof err)); },
    });
    const client = link.client;
    const bell = new MobileBell({
      target: () => {
        if (!started || stopped || phones !== true || !p.sync.canCarryMobile()) return null;
        if ((client.lastWorkerCompat?.() ?? 0) < MOBILE_BELL_MIN_WORKER_COMPAT) return null;
        return client.bellTarget?.() ?? null;
      },
      onLaunch: () => {
        // 今の engine の pull で依頼を受け取る。走っている pull があれば、それを分け合う。
        void p.sync.engine.pullNow().catch((e: unknown) => console.error('[mobile] could not pull after the bell', e instanceof Error ? e.constructor.name : typeof e));
      },
      onAsk: (id, sealed, epoch) => answerAsk({
        phoneKeys: link.phoneKeys,
        deviceId,
        projectPath: (projectId) => (rootHere.get(projectId, deviceId) as { path: string } | undefined)?.path ?? null,
        accountDir: (accountId) => accounts.store.list().find((a) => a.id === accountId)?.dir ?? null,
        ...(opencodeAsk ? { opencode: opencodeAsk } : {}),
      }, id, sealed, epoch),
      timers,
      ...(p.bellConnect ? { connect: p.bellConnect } : {}),
    });
    cur = { pub, inbox, bell, link };
    pub.start();
    return pub;
  };
  /** 呼び鈴を張るかどうかを読み直す。投げない。 */
  const ringCheck = (): void => {
    try { cur?.bell.check(); } catch (e) { console.error('[mobile] could not check the bell', e instanceof Error ? e.constructor.name : typeof e); }
  };
  const kick = (): void => {
    try { ensure()?.nudge(); } catch (e) { console.error('[mobile] could not schedule the mobile feed', e instanceof Error ? e.constructor.name : typeof e); }
    ringCheck();
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
    if (d.state === 'ok') phoneNames = new Map(d.devices.flatMap((x) => (x.kind === 'mobile' && x.name ? [[x.id, x.name] as const] : [])));
    const next = d.state === 'ok' ? d.devices.some((x) => x.kind === 'mobile' && x.revokedAt === null) : d.state === 'outdated' ? false : null;
    const appeared = next === true && phones !== true;
    phones = next;
    if (next === true) hadPhones = true;
    // 最後のスマホを外した（一覧が読めて、外していないスマホが無い）ら、Worker の受信箱の素を消す。
    if (d.state === 'ok' && next === false && hadPhones) dropFeed();
    // スマホが居なくなったら呼び鈴を閉じ、現れたら張る。
    if (!appeared) { ringCheck(); return; }
    cur?.pub.forget();
    kick();
  }
  /** 受信箱の素を Worker から消す。消せたら、次に居なくなるまで消さない。消せなければ、次の読み直しでやり直す。投げない。 */
  function dropFeed(): void {
    try {
      const pub = cur?.pub;
      if (!pub || !p.sync.canCarryMobile()) return;
      void pub.dropFeed().then((done) => { if (done) hadPhones = false; }).catch((e: unknown) => { console.error('[mobile] could not drop the mobile feed', e instanceof Error ? e.constructor.name : typeof e); });
    } catch (e) {
      console.error('[mobile] could not drop the mobile feed', e instanceof Error ? e.constructor.name : typeof e);
    }
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
  /**
   * スマホの依頼で起こした会話を、画面の右下の通知に配る（phone.launch、試作 F1）。
   * スマホの名前は読めた一覧（名簿）から引く。知らない ID なら一覧を 1 回だけ読み直し、それでも無ければ null（画面は「スマホから起動」と出す）。
   * 同じ ID の読み直しは、最後の読み直しから PHONE_NAME_REREAD_MS の間はしない（外したスマホの残りの依頼が続けて来ても一覧を読み続けない）。
   */
  async function announceLaunch(e: PhoneLaunchStarted): Promise<void> {
    const hub = p.delivery.hub;
    if (!hub) return;
    let phone = e.from ? phoneNames.get(e.from) ?? null : null;
    const lastReread = e.from ? phoneRereadAt.get(e.from) : undefined;
    if (e.from && phone === null && p.sync.canCarryMobile() && (lastReread === undefined || now() - lastReread >= PHONE_NAME_REREAD_MS)) {
      phoneRereadAt.set(e.from, now());
      await p.sync.cloudDevices().catch(() => undefined);
      phone = phoneNames.get(e.from) ?? null;
    }
    hub.broadcast({ type: 'phone.launch', launch: { sessionId: e.sessionId, phone, projectId: e.projectId, scratch: e.scratch, permissionMode: e.permissionMode, title: e.title, at: now() } });
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
      offs.push(p.delivery.live.onChange(() => kick()));
      offs.push(onIntent(() => kick()));
      offs.push(p.runs.runs.on({ remoteUrl: () => kick() }));
      offs.push(onRowChange((c) => { if (c.db === db && FEED_TABLES.has(c.table)) kick(); }));
      offs.push(p.sync.onCloudDevices(notePhones));
      accounts.broadcast = wrapped;
      offs.push(() => { if (accounts.broadcast === wrapped) accounts.broadcast = original; });
      // 起動のときに同期が無かった端末で、cloud.json が後から現れたのを拾う見回り。書き手が居れば何もしない。
      sweep = timers.setInterval(() => {
        try { ensure(); } catch (e) { console.error('[mobile] could not set up the mobile feed', e instanceof Error ? e.constructor.name : typeof e); }
        // Worker の版は pull の応答で後から分かるので、見回りでも呼び鈴を読み直す。
        ringCheck();
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
      ringCheck();
      checkPhones();
    },
    settingsChanged() {
      if (!started || stopped) return;
      kick();
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
      cur?.bell.stop();
      cur = null;
    },
  };
}
