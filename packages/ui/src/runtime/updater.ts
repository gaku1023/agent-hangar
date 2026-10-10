import { reduceUpdate, updateBusy, type UpdateEvent, type UpdateState } from '../store/update.ts';
import { UpdateFailure, type UpdateBridge } from './desktop.ts';

/** 自動の確認の間隔。起動したときに 1 度、その後はこの間隔で GitHub の Release の目録を引く（控えめにする）。 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000;
/** 取得の最中に、殻へ進みを読みに行く間隔。 */
export const UPDATE_PROGRESS_POLL_MS = 500;
/** 札を閉じた版を残す localStorage の鍵。端末ごとで、同期しない。 */
export const UPDATE_DISMISSED_KEY = 'update.dismissed';
/** 新しい版を知らせるか（設定のスイッチ）を残す localStorage の鍵。無ければ知らせる。 */
export const UPDATE_NOTIFY_KEY = 'update.notify';

/** 画面からの操作。Mediator が update の効果にして渡す（mediator/update.ts）。 */
export type UpdateCommand = { op: 'check' } | { op: 'download' } | { op: 'install' } | { op: 'dismiss' } | { op: 'notify'; on: boolean };

export type UpdateRunnerDeps = {
  bridge: UpdateBridge;
  storage: { get(key: string): unknown; set(key: string, value: unknown): void };
  setTimeout: (fn: () => void, ms: number) => unknown;
  now: () => number;
  /** いまの更新の状態（Store の update）を読む口と、置く口。 */
  get(): UpdateState;
  set(next: UpdateState): void;
};

/**
 * 殻の updater を呼び、結果を状態に移す（状態の移り方は store/update.ts の reduceUpdate）。
 * 起動したら殻の版を読み、知らせを入れていればすぐ 1 度確認し、その後は UPDATE_CHECK_INTERVAL_MS おきに確認する。
 * 知らせを切っていれば自動では確認しない（手動の確認は常に使える）。
 * 取得からインストールまでの途中は、見つけた版を差し替えないよう、確認をしない。
 * 殻が版を答えなければ（ブラウザ、updater の無い殻、権限で断られた）、何もしない。
 */
export function createUpdateRunner(d: UpdateRunnerDeps) {
  const apply = (e: UpdateEvent) => d.set(reduceUpdate(d.get(), e));
  const reasonOf = (e: unknown) => (e instanceof UpdateFailure ? e.reason : 'other');

  function check(manual: boolean): void {
    const s = d.get();
    if (!s.supported || s.phase.kind === 'checking' || updateBusy(s.phase)) return;
    apply({ type: 'check.start', manual });
    d.bridge.check().then(
      (r) => apply({ type: 'check.done', version: r.version, at: d.now() }),
      (e: unknown) => apply({ type: 'check.failed', reason: reasonOf(e) }),
    );
  }

  /** 数時間おきの確認。予約は 1 本だけを回し続け、知らせを切っている間は確認だけを飛ばす。 */
  function schedule(): void {
    d.setTimeout(() => {
      if (d.get().notify) check(false);
      schedule();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  /** 取得の最中だけ、殻へ進みを読みに行く。 */
  function poll(): void {
    d.setTimeout(() => {
      if (d.get().phase.kind !== 'downloading') return;
      d.bridge.status().then((r) => {
        if (d.get().phase.kind === 'downloading') apply({ type: 'download.progress', done: r.done, total: r.total });
      }, () => {}).finally(() => poll());
    }, UPDATE_PROGRESS_POLL_MS);
  }

  function download(): void {
    const before = d.get();
    apply({ type: 'download.start' });
    if (d.get().phase.kind !== 'downloading' || before === d.get()) return;
    saveDismissed(before);
    poll();
    d.bridge.download().then(
      () => apply({ type: 'download.done' }),
      (e: unknown) => apply({ type: 'download.failed', reason: reasonOf(e) }),
    );
  }

  function install(): void {
    apply({ type: 'install.start' });
    if (d.get().phase.kind !== 'installing') return;
    // 入れ終えると殻がアプリを再起動するので、成功の答えは戻らないことがある。
    d.bridge.install().catch((e: unknown) => apply({ type: 'install.failed', reason: reasonOf(e) }));
  }

  function saveDismissed(before: UpdateState): void {
    const now = d.get().dismissed;
    if (now !== before.dismissed) d.storage.set(UPDATE_DISMISSED_KEY, now);
  }

  return {
    start(): void {
      apply({ type: 'restore', dismissed: d.storage.get(UPDATE_DISMISSED_KEY), notify: d.storage.get(UPDATE_NOTIFY_KEY) });
      d.bridge.status().then((r) => {
        apply({ type: 'supported', current: r.current });
        if (d.get().notify) check(false);
        schedule();
      }, () => {});
    },
    run(c: UpdateCommand): void {
      if (!d.get().supported) return;
      switch (c.op) {
        case 'check': check(true); return;
        case 'download': download(); return;
        case 'install': install(); return;
        case 'dismiss': { const before = d.get(); apply({ type: 'dismiss' }); saveDismissed(before); return; }
        case 'notify': {
          apply({ type: 'notify', on: c.on });
          d.storage.set(UPDATE_NOTIFY_KEY, c.on);
          // 入れ直したら、次の予約を待たずに 1 度確認する。
          if (c.on) check(false);
          return;
        }
      }
    },
  };
}
