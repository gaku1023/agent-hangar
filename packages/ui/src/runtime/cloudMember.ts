import type { CloudDevicesDto } from '@agent-hangar/shared';
import { reduceCloudMember, type CloudMemberEvent, type CloudMemberState } from '../store/cloudMember.ts';
import type { CloudBridge } from './desktop.ts';

/**
 * 参加か、この PC の参加の解除が済んでから、アプリの再起動を頼むまでの間。
 * サーバは起動のときにしか cloud.json を読まないので、立て直すまで同期は始まらない（解除なら止まらない）。
 * 済んだことを画面で読める間を置いてから再起動する。
 */
export const CLOUD_RESTART_MS = 1500;

/** 画面からの操作。Mediator が cloudMember の効果にして渡す（mediator/cloudMember.ts）。 */
export type CloudMemberCommand =
  | { op: 'load' }
  | { op: 'plan'; token: string } | { op: 'join'; overwrite: boolean } | { op: 'joinCancel' }
  | { op: 'revoke'; id: string } | { op: 'revokeDismiss' }
  | { op: 'leave'; revoke: boolean } | { op: 'leaveDismiss' };

export type CloudMemberRunnerDeps = {
  /** 殻のクラウド同期の命令。ブラウザでは null で、参加と解除は何もしない（画面がコマンドを案内する）。 */
  bridge: CloudBridge | null;
  /** Worker の PC の一覧を取る（GET /api/sync/cloud-devices）。 */
  load: () => Promise<CloudDevicesDto>;
  /** アプリを再起動する（殻の restart_app）。 */
  restart: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  get(): CloudMemberState;
  set(next: CloudMemberState): void;
};

/** 参加トークンを捨てる失敗。貼り直してもらうものである（読めない、秘密が違う、形が違う）。 */
const DROP_TOKEN = new Set(['invalid-token', 'forbidden']);

/**
 * 殻のクラウド同期の命令を呼び、結果を状態に移す（状態の移り方は store/cloudMember.ts の reduceCloudMember）。
 * 参加トークンはこの中の変数にだけ持つ。Store にも画面にも置かず、参加が済むか、段を閉じるか、貼り直しの要る失敗で捨てる。
 */
export function createCloudMemberRunner(d: CloudMemberRunnerDeps) {
  const apply = (e: CloudMemberEvent) => d.set(reduceCloudMember(d.get(), e));
  let held: string | null = null;

  function load(): void {
    // 取れなければ前の一覧のまま。理由は、サーバが一覧の答え（state と message）に載せて返す。
    d.load().then((devices) => apply({ type: 'devices.loaded', devices }), () => {});
  }

  function plan(token: string): void {
    const t = token.trim();
    if (!d.bridge || t === '' || d.get().join.kind === 'checking' || d.get().join.kind === 'joining') return;
    held = t;
    apply({ type: 'join.checking' });
    d.bridge.joinPlan(t).then((r) => {
      if (r.ok) { apply({ type: 'join.planned', plan: r.value }); return; }
      held = null;
      apply({ type: 'join.failed', failure: r.failure });
    });
  }

  function join(overwrite: boolean): void {
    const token = held;
    if (!d.bridge || token === null || d.get().join.kind === 'joining') return;
    apply({ type: 'join.joining' });
    d.bridge.join(token, overwrite).then((r) => {
      if (r.ok) {
        held = null;
        apply({ type: 'join.joined', host: r.value.host });
        d.setTimeout(d.restart, CLOUD_RESTART_MS);
        return;
      }
      if (DROP_TOKEN.has(r.failure.code)) held = null;
      apply({ type: 'join.failed', failure: r.failure });
    });
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
      // クラウドで解除できなかったときは、ほかの PC から解除するよう読んでもらう間が要る。再起動は画面のボタンに任せる。
      if (r.value.revokeError === null) d.setTimeout(d.restart, CLOUD_RESTART_MS);
    });
  }

  function run(c: CloudMemberCommand): void {
    switch (c.op) {
      case 'load': load(); return;
      case 'plan': plan(c.token); return;
      case 'join': join(c.overwrite); return;
      case 'joinCancel': held = null; apply({ type: 'join.reset' }); return;
      case 'revoke': revoke(c.id); return;
      case 'revokeDismiss': apply({ type: 'revoke.reset' }); return;
      case 'leave': leave(c.revoke); return;
      case 'leaveDismiss': apply({ type: 'leave.reset' }); return;
    }
  }

  return { run };
}
