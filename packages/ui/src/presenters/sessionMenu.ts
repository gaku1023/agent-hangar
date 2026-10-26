import type { PaneId, SessionDto, SessionStatus, Translate, UiAction } from '@agent-hangar/shared';
import { asideOf } from '../lib/aside.ts';
import { aliveRunOf, tabsOf, type Store } from '../store/store.ts';
import type { IconName } from '../views/primitives/Icon.tsx';
import { resumeHereOf } from './resumeHere.ts';
import { ACTIVE_LABEL, STATUS_LABEL } from './row.ts';

/** 停止に要るもの。止めるときの確認（作業中、裏の作業、シェルタブ）はセッション画面の「停止」と同じに数える。 */
export type SessionMenuStop = { runId: string; working: boolean; aside: boolean; shellTabs: number };

/**
 * セッションのメニュー（1A）の中身。ホームとプロジェクト画面の一覧、ホームの帯、サイドバーで同じものを出す。
 * status は状態で、Active は null。
 * resumeHere はほかの PC の会話の「この PC で再開」で、disabled は押せない理由。ほかの PC の会話でなければ null。
 * stop は動いている会話の停止。hangar の run があればその中身、hangar の外で動いていれば external、動いていなければ null。
 * moveBlocked は、移動を押せない理由。押せるなら null。
 * 削除は動いていない（stop が null の）ときだけ出す。動いている間は停止を出し、止めると削除に入れ替わる。
 */
export type SessionMenuProps = { id: string; name: string; status: SessionStatus | null; resumeHere: { disabled: string | null } | null; stop: SessionMenuStop | 'external' | null; moveBlocked: string | null;
  /** そのセッションが分割の木にあるときのペイン。あれば分割のまとまりの先頭に「表示中のペインへ移動」を出す。木に無ければ null か省く。 */
  pane?: PaneId | null };

/** 状態の色の点。プロジェクトの状態の点（.st-dot）と同じ 4 色を使う。 */
export type SessionMenuDot = 'active' | 'paused' | 'done' | 'archived';

/**
 * メニューの 1 項目。画面の部品（MenuItem）に依らない形で持ち、View が押したときに send を出す。
 * send が null の項目は、押しても何もしない（いまの状態を選び直したとき）。
 * checked を持つ項目は、選べる状態の 1 つで、いまの状態に ✓ を付ける。
 * separatorBefore は、この項目の前に区切りを置くこと。
 */
export type SessionMenuEntry = { key: string; label: string; send: UiAction | null; disabled: string | null; kbd?: string; icon?: IconName; dot?: SessionMenuDot; checked?: boolean; separatorBefore?: boolean; danger?: boolean; note?: string;
  /** 押すと開くサブメニュー（ペインの右クリックのステータス）。持つ項目は send を持たない。 */
  sub?: SessionMenuEntry[] };

/**
 * 移せる先。いまの所属のほかの、一覧から消していないプロジェクトである。しまったプロジェクトは数えない。
 * クイックセッションは全 PC で 1 つのプロジェクトにまとめてある（projects/scratch.ts）ので、その 1 つを並べる。この PC の場所は quick-sessions である。
 * 移す先の選び方（presenters/moveSession.ts）も、メニューの押せるかどうかも、これで決める。
 */
export function moveTargetIds(store: Store, current: string | null): string[] {
  return Object.values(store.projects).filter((p) => p.id !== current && p.status !== 'archived').map((p) => p.id);
}

/**
 * 1 つのセッションのメニューの中身を、Store から作る。
 * 動いているかは、Claude が見えているか（live）か、hangar の run が生きているかで決める。
 * サーバの削除は、この PC で run が生きているか Claude が見えていれば 409 で断るので、削除を出すかどうかも同じ見方（stop の有無）にする。
 * 区切りを付けて休みのまま残っているもの（parked）も、プロセスが残っている間は動いているものとして扱う。
 */
export function presentSessionMenu(store: Store, s: SessionDto, t: Translate): SessionMenuProps {
  const run = aliveRunOf(store, s.id);
  const running = run !== null || s.live !== null;
  const stop: SessionMenuProps['stop'] = run
    ? { runId: run.id, working: s.live === 'busy' || s.live === 'waiting', aside: asideOf(s.live, s.liveAside) !== null, shellTabs: tabsOf(store, run.id).filter((tab) => tab.kind === 'shell').length }
    : running ? 'external' : null;
  const here = resumeHereOf(store, s, t);
  return {
    id: s.id,
    name: s.name ?? t('common.label.noName'),
    status: s.state?.status ?? null,
    resumeHere: here ? { disabled: here.disabled } : null,
    stop,
    moveBlocked: moveTargetIds(store, s.projectId).length === 0 ? t('row.menu.moveNone') : null,
  };
}

const STATES: { key: SessionMenuDot; kbd: string }[] = [{ key: 'active', kbd: 'u' }, { key: 'paused', kbd: 'p' }, { key: 'done', kbd: 'd' }, { key: 'archived', kbd: 'a' }];

/**
 * メニューの項目を並べる（試作の 1A）。
 * 条件付きの「この PC で再開」、状態の 4 つ、区切り、分割の項目（木にあれば「表示中のペインへ移動」、「右に分割して開く」、「下に分割して開く」）、区切り、「プロジェクトを変更…」、「セッション ID をコピー」、区切り、「停止」（動いているとき）か「削除…」（動いていないとき）の順に置く。
 * 動いている間に押せない「削除…」を並べない。サイドバーは動いているものだけを並べるので、そこでは削除がいつも押せないまま出ることになるからである。
 * 状態はいまのものに ✓ を付ける。いまの状態を選び直したときは、Paused なら戻る日のダイアログを開き（日を変えるため）、ほかは何もしない。
 * 停止は確認の要否を Mediator に任せる（作業中やシェルタブがあれば確認を出す）。hangar の外で動いているものは押せない理由を添える。
 * 危険色は停止と削除だけにする。停止の補足の 1 行は出さない。
 */
export function sessionMenuEntries(t: Translate, m: SessionMenuProps): SessionMenuEntry[] {
  const states = statusEntries(m.id, m.status);
  const stop = m.stop;
  // 分割で開く 2 つ（画面の分割）は、状態の 4 つの後ろに、区切りを置いてまとめる。最初のフォーカスは今までどおり状態に置く。
  // 木にあるセッションなら、まとまりの先頭に「表示中のペインへ移動」を足す。
  // 開く先は操作中のペイン（target は null）で、すでに木にあるセッションは mediator が新しく開かずそのペインへ移す。
  // ほかの PC の会話の「この PC で再開」は、その会話の主の操作なので、状態より先（先頭）に置く。
  const goToPane: SessionMenuEntry[] = m.pane ? [{ key: 'goToPane', label: t('row.menu.goToPane'), icon: 'paneOpen', disabled: null, send: { type: 'pane.focus', pane: m.pane } }] : [];
  const split = ([
    ...goToPane,
    { key: 'splitRight', label: t('row.menu.splitRight'), icon: 'splitRight', disabled: null, send: { type: 'pane.open', sessionId: m.id, target: null, side: 'right' } },
    { key: 'splitDown', label: t('row.menu.splitDown'), icon: 'splitDown', disabled: null, send: { type: 'pane.open', sessionId: m.id, target: null, side: 'down' } },
  ] satisfies SessionMenuEntry[]).map((e, i): SessionMenuEntry => (i === 0 ? { ...e, separatorBefore: true } : e));
  return [
    ...(m.resumeHere ? [{ key: 'resumeHere', label: t('session.action.resumeHere'), icon: 'resumeHere' as const, disabled: m.resumeHere.disabled, send: { type: 'session.resumeHere.open', id: m.id } as const }] : []),
    ...states,
    ...split,
    { key: 'move', label: t('row.menu.move'), icon: 'moveSession', kbd: 'm', separatorBefore: true, disabled: m.moveBlocked, send: { type: 'session.move.open', id: m.id } },
    { key: 'copyId', label: t('session.action.copyId'), icon: 'copy', disabled: null, send: { type: 'session.copyId', id: m.id } },
    stop
      ? { key: 'stop', label: t('sidebar.live.stop'), icon: 'stop', danger: true, separatorBefore: true, disabled: stop === 'external' ? t('sidebar.live.stopExternal') : null, send: stop === 'external' ? null : { type: 'session.kill', ...stop } }
      : { key: 'delete', label: t('row.menu.delete'), icon: 'trash', danger: true, separatorBefore: true, disabled: null, send: { type: 'session.delete.open', id: m.id } },
  ];
}

/**
 * 状態の 4 つ。セッションのメニューとペインの右クリックのサブメニューで同じものを出す。
 * いまの状態に ✓ を付ける。いまの状態を選び直したときは、Paused なら戻る日のダイアログを開き、ほかは何もしない。
 */
export function statusEntries(id: string, status: SessionStatus | null): SessionMenuEntry[] {
  const current: SessionMenuDot = status ?? 'active';
  return STATES.map(({ key, kbd }): SessionMenuEntry => {
    const send: UiAction | null = key === 'paused' ? { type: 'session.pause.open', id, from: 'menu' }
      : key === current ? null
        : { type: 'session.state.set', id, status: key === 'active' ? null : key };
    return { key, label: key === 'active' ? ACTIVE_LABEL : STATUS_LABEL[key], dot: key, kbd, checked: key === current, send, disabled: null };
  });
}
