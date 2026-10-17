import { normalizeJoinCode, type CloudDevicesDto, type JoinApproverState, type MobilePairingDto } from '@agent-hangar/shared';
import { reduceCloudMember, type CloudMemberEvent, type CloudMemberState, type JoinFailReason } from '../store/cloudMember.ts';
import type { CloudBridge } from './desktop.ts';

/**
 * 参加か、この PC の参加の解除が完了してから、アプリの再起動を頼むまでの間。
 * サーバーは起動のときにしか cloud.json を読まないので、再起動するまで同期は開始しない（解除なら停止しない）。
 * 完了したことを画面で読める間を置いてから再起動する。
 */
export const CLOUD_RESTART_MS = 1500;

/** 新しい PC が承認を問い合わせる間隔（計画の決定。1 回の参加で最大 150 回）。 */
export const JOIN_POLL_MS = 2_000;

/** 承認の後、新しい PC が一覧に現れるまで取り直す回数の上限。新しい PC が Worker の一覧に入るのは、承認の後の最初の問い合わせのときである。 */
const ADDED_RELOADS = 5;

/** 画面からの操作。Mediator が cloudMember の効果にして渡す（mediator/cloudMember.ts）。 */
export type CloudMemberCommand =
  | { op: 'load' }
  | { op: 'check'; url: string } | { op: 'request'; code: string } | { op: 'joinReenter' } | { op: 'joinCancel' }
  | { op: 'addOpen' } | { op: 'addApprove' } | { op: 'addReject' } | { op: 'addClose' }
  | { op: 'revoke'; id: string } | { op: 'revokeDismiss' }
  | { op: 'leave'; revoke: boolean } | { op: 'leaveDismiss' }
  | { op: 'pair' } | { op: 'pairClose' };

/** QR を出している間、端末の一覧を再読み込みする間隔。スマホが参加したのを、この間隔で知る。承認の後に新しい PC を待つ間隔も同じ。 */
export const PAIR_POLL_MS = 3_000;

/** 発行した PC の口（サーバーの /api/sync/join-codes）。どれも承認の状態を返す。失敗はサーバーの文で投げる。 */
export type JoinCodesApi = {
  current(): Promise<JoinApproverState>;
  issue(): Promise<JoinApproverState>;
  approve(): Promise<JoinApproverState>;
  reject(): Promise<JoinApproverState>;
  close(): Promise<JoinApproverState>;
};

export type CloudMemberRunnerDeps = {
  /** 殻のクラウド同期の命令。ブラウザでは null で、参加と解除は何もしない（画面がコマンドを案内する）。 */
  bridge: CloudBridge | null;
  /** Worker の PC の一覧を取る（GET /api/sync/cloud-devices）。 */
  load: () => Promise<CloudDevicesDto>;
  /** スマホを接続する QR の券を取る（POST /api/sync/mobile-pairing）。 */
  pair: () => Promise<MobilePairingDto>;
  /** 「PC を追加」の参加コードの発行と承認。ブラウザでも使う（サーバーの経路だけを使う）。 */
  joinCodes: JoinCodesApi;
  /** 今の時刻（ms）。QR と参加コードの期限の判定に使う。 */
  now: () => number;
  /** アプリを再起動する（殻の restart_app）。 */
  restart: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  get(): CloudMemberState;
  set(next: CloudMemberState): void;
};

/** 接続先の確認と参加リクエストの失敗の符号を、参加が終わった理由にする。 */
function requestReason(code: string): JoinFailReason {
  switch (code) {
    case 'invalid-code': return 'bad-code';
    case 'code-not-found': return 'expired';
    case 'rate-limited': return 'rate-limited';
    case 'join-pending': return 'pending';
    case 'network': case 'timeout': case 'unreachable': return 'network';
    case 'compat': return 'compat';
    default: return 'other';
  }
}

/** 問い合わせの失敗のうち、待ち続けるもの。殻が前の問い合わせを走らせている（busy）か、一時的に接続できないもの。 */
const KEEP_WAITING = new Set(['busy', 'network', 'timeout', 'unreachable']);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 殻のクラウド同期の命令とサーバーの参加コードの口を呼び、結果を状態に移す（状態の移り方は store/cloudMember.ts の reduceCloudMember）。
 * 新しい PC が入力した参加コードは、半角にそろえて殻へ渡すだけで、Store にも画面にも保持しない。
 */
export function createCloudMemberRunner(d: CloudMemberRunnerDeps) {
  const apply = (e: CloudMemberEvent) => d.set(reduceCloudMember(d.get(), e));

  function load(): void {
    // 取れなければ前の一覧のまま。理由は、サーバーが一覧の答え（state と message）に載せて返す。
    d.load().then((devices) => apply({ type: 'devices.loaded', devices }), () => {});
    // 発行中の参加コードの状態。同期を設定していなければ 404 なので、何もしない。
    d.joinCodes.current().then((state) => apply({ type: 'add.state', state }), () => {});
  }

  /**
   * 参加（新しい PC の側）。段を開き直すたびに世代を進め、前の段の問い合わせの予約は世代が違えば何もしない。
   * 承認を待つ間は JOIN_POLL_MS ごとに 1 本ずつ問い合わせ、承認、拒否、期限切れ、5 分の経過のどれかで停止する。
   */
  let joinGen = 0;
  const joinLive = (gen: number) => gen === joinGen && d.get().join.kind === 'waiting';

  function check(url: string): void {
    const u = url.trim();
    const k = d.get().join.kind;
    if (!d.bridge || u === '' || k === 'checking' || k === 'requesting' || k === 'waiting') return;
    // 殻も https で始まらない URL を断る。ここで断れば、殻と CLI を呼ばずに済む。
    if (!/^https:\/\/[^\s/]+/.test(u)) { apply({ type: 'join.checkFailed', failure: { code: 'invalid-url', message: '' } }); return; }
    const gen = ++joinGen;
    apply({ type: 'join.checking', url: u });
    d.bridge.joinCheck(u).then((r) => {
      if (gen !== joinGen) return;
      apply(r.ok ? { type: 'join.checked', check: r.value } : { type: 'join.checkFailed', failure: r.failure });
    });
  }

  function poll(gen: number, expiresAt: number): void {
    d.setTimeout(() => {
      if (!joinLive(gen) || !d.bridge) return;
      d.bridge.joinPoll().then((r) => {
        if (!joinLive(gen)) return;
        if (r.ok) {
          const s = r.value.status;
          if (s === 'approved') {
            apply({ type: 'join.done' });
            d.setTimeout(d.restart, CLOUD_RESTART_MS);
            return;
          }
          if (s === 'rejected') { apply({ type: 'join.failed', reason: 'rejected', message: '' }); return; }
          // 期限切れと下書きが無いのは、5 分の間に承認されなかったということである（発行した PC がスリープ中など）。
          if (s === 'expired' || s === 'none') { apply({ type: 'join.failed', reason: 'no-answer', message: '' }); return; }
        } else if (!KEEP_WAITING.has(r.failure.code)) {
          apply({ type: 'join.failed', reason: r.failure.code === 'compat' ? 'compat' : 'other', message: r.failure.message });
          return;
        }
        // まだ待っている。期限を過ぎたら、最後の問い合わせの答えを見たうえで終える（固まらない）。
        if (d.now() >= expiresAt) { apply({ type: 'join.failed', reason: 'no-answer', message: '' }); return; }
        poll(gen, expiresAt);
      });
    }, JOIN_POLL_MS);
  }

  function request(input: string): void {
    const j = d.get().join;
    if (!d.bridge || j.kind !== 'code') return;
    const code = normalizeJoinCode(input);
    // 形の違うコードは Worker に送らない（総当たりの回数を消費しない）。
    if (code === null) { apply({ type: 'join.failed', reason: 'bad-code', message: '' }); return; }
    const gen = ++joinGen;
    apply({ type: 'join.requesting' });
    d.bridge.joinRequest(j.check.url, code, j.check.current !== null).then((r) => {
      if (gen !== joinGen) return;
      if (!r.ok) { apply({ type: 'join.failed', reason: requestReason(r.failure.code), message: r.failure.message }); return; }
      apply({ type: 'join.waiting', sas: r.value.sas, expiresAt: r.value.expiresAt });
      poll(gen, r.value.expiresAt);
    });
  }

  function joinReset(e: CloudMemberEvent): void {
    joinGen++;
    apply(e);
  }

  /**
   * 「PC を追加」（発行した PC の側）。状態はサーバーの承認の状態を写す（WebSocket の join.update でも受信する）。
   * 承認が完了したら、新しい PC が一覧に現れるまで PAIR_POLL_MS ごとに取り直す（ADDED_RELOADS 回まで）。
   */
  const fail = (e: unknown) => apply({ type: 'add.state', state: { kind: 'failed', message: errorText(e) } });
  function addOpen(): void {
    const k = d.get().add.kind;
    if (k === 'issuing' || k === 'approving') return;
    apply({ type: 'add.issuing' });
    d.joinCodes.issue().then((state) => apply({ type: 'add.state', state }), fail);
  }
  function reloadUntilAdded(known: Set<string>, left: number): void {
    d.load().then((devices) => {
      apply({ type: 'devices.loaded', devices });
      const arrived = devices.state === 'ok' && devices.devices.some((x) => !known.has(x.id));
      if (!arrived && left > 1) d.setTimeout(() => reloadUntilAdded(known, left - 1), PAIR_POLL_MS);
    }, () => { if (left > 1) d.setTimeout(() => reloadUntilAdded(known, left - 1), PAIR_POLL_MS); });
  }
  function addApprove(): void {
    if (d.get().add.kind !== 'requested') return;
    const known = new Set((d.get().devices?.devices ?? []).map((x) => x.id));
    apply({ type: 'add.state', state: { kind: 'approving' } });
    d.joinCodes.approve().then((state) => {
      apply({ type: 'add.state', state });
      if (state.kind === 'done') reloadUntilAdded(known, ADDED_RELOADS);
    }, fail);
  }
  function addReject(): void {
    const a = d.get().add;
    if (a.kind !== 'requested') return;
    // 先に拒否の知らせにする。サーバーが先に idle を配っても、欄が一度閉じてから開き直さないようにするためである。
    apply({ type: 'add.rejected', name: a.request.name });
    d.joinCodes.reject().then(() => {}, fail);
  }
  function addClose(): void {
    apply({ type: 'add.reset' });
    // 生きている参加コードは Worker で閉じる。完了や期限切れの後でも、サーバーは idle を返すだけである。
    d.joinCodes.close().then(() => {}, () => {});
  }

  function revoke(id: string): void {
    if (!d.bridge || d.get().revoke?.kind === 'busy') return;
    apply({ type: 'revoke.start', id });
    d.bridge.revoke(id).then((r) => {
      if (!r.ok) { apply({ type: 'revoke.failed', id, failure: r.failure }); return; }
      apply({ type: 'revoke.done', device: r.value });
      load();
    });
  }

  function leave(revokeInCloud: boolean): void {
    if (!d.bridge || d.get().leave.kind === 'busy') return;
    apply({ type: 'leave.start' });
    d.bridge.leave(revokeInCloud).then((r) => {
      if (!r.ok) { apply({ type: 'leave.failed', failure: r.failure }); return; }
      apply({ type: 'leave.done', revokeError: r.value.revokeError });
      // クラウドで解除できなかったときは、他の PC から解除するよう読んでもらう間が必要である。再起動は画面のボタンに任せる。
      if (r.value.revokeError === null) d.setTimeout(d.restart, CLOUD_RESTART_MS);
    });
  }

  /**
   * スマホを接続する QR。出すたびに世代を進め、前の QR の予約（再読み込みと期限）は世代が違えば何もしない。
   * 再読み込みは QR を出している間（ready）だけ PAIR_POLL_MS ごとに 1 本ずつ走らせ、閉じる、期限が切れる、スマホが参加する、のどれかで停止する。
   */
  let pairGen = 0;
  const pairLive = (gen: number) => gen === pairGen && d.get().phone.kind === 'ready';
  function pollPhones(gen: number): void {
    d.setTimeout(() => {
      if (!pairLive(gen)) return;
      d.load().then((devices) => { if (gen === pairGen) apply({ type: 'devices.loaded', devices }); pollPhones(gen); }, () => pollPhones(gen));
    }, PAIR_POLL_MS);
  }
  function pair(): void {
    if (d.get().phone.kind === 'loading') return;
    const gen = ++pairGen;
    apply({ type: 'phone.loading' });
    d.pair().then((pairing) => {
      if (gen !== pairGen) return;
      apply({ type: 'phone.loaded', pairing });
      if (pairing.state !== 'ready') return;
      pollPhones(gen);
      d.setTimeout(() => { if (pairLive(gen)) apply({ type: 'phone.expired' }); }, Math.max(0, pairing.expiresAt - d.now()));
    }, (e: unknown) => {
      if (gen === pairGen) apply({ type: 'phone.failed', message: errorText(e) });
    });
  }

  function run(c: CloudMemberCommand): void {
    switch (c.op) {
      case 'load': load(); return;
      case 'check': check(c.url); return;
      case 'request': request(c.code); return;
      case 'joinReenter': joinReset({ type: 'join.reenter' }); return;
      case 'joinCancel': joinReset({ type: 'join.reset' }); return;
      case 'addOpen': addOpen(); return;
      case 'addApprove': addApprove(); return;
      case 'addReject': addReject(); return;
      case 'addClose': addClose(); return;
      case 'revoke': revoke(c.id); return;
      case 'revokeDismiss': apply({ type: 'revoke.reset' }); return;
      case 'leave': leave(c.revoke); return;
      case 'leaveDismiss': apply({ type: 'leave.reset' }); return;
      case 'pair': pair(); return;
      case 'pairClose': pairGen++; apply({ type: 'phone.reset' }); return;
    }
  }

  return { run };
}
