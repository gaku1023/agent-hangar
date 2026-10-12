import type { GitDto } from '@agent-hangar/shared';

/** 見えている行が替わってから取りに行くまで待つ長さ。続けて届く知らせ（一覧とセッション画面）を 1 回にまとめる。 */
export const GIT_BATCH_MS = 150;
/** 窓が前にある間に取り直す周期。 */
export const GIT_POLL_MS = 30_000;
/** 同じ行を続けて取らない長さ。一覧が描き直されるたびに知らせが来ても、取りに行くのは 1 回にする。 */
const FRESH_MS = 5_000;
/** 1 回で聞ける数（サーバの上限と同じ）。 */
const CHUNK = 200;

export type GitWatchDeps = {
  fetch: (ids: string[]) => Promise<GitDto>;
  apply: (g: GitDto) => void;
  /** 実行中のセッション。見えていなくても取る（ホームの引き出し、サイドバー、現在の札）。 */
  live: () => string[];
  /** 窓が前にあるか（document.visibilityState）。裏にある間は取らない。 */
  visible: () => boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  now: () => number;
  /**
   * 行のほかに、周期と窓が前に戻ったときに取り直すもの（開いているプロジェクト画面のブランチと worktree）。
   * 開いたままの画面で、ブランチを替えたり持ち主を直したりしても古いまま残らないようにする。
   */
  also?: () => void;
};

/**
 * git の表示の取り方（0.5.0）。
 * 画面（一覧、セッション画面）は見えている行のセッションを git.watch で知らせ、ここが場所ごとに覚える。
 * 替わったら少し待ってまとめて POST /api/git/sessions を呼び、窓が前にある間は 30 秒ごとに全部を取り直す。
 * 周期と窓が前に戻ったときには、開いているプロジェクト画面のブランチと worktree（also）も取り直す。
 * 実行中のセッションの書き込みは、サーバが git.upsert で配るので、周期はその取りこぼしを拾う役である。
 * 終わったセッションの値はサーバが 60 秒覚えるので、何度呼んでも git は走らない。
 */
export function createGitWatch(d: GitWatchDeps) {
  const wanted = new Map<string, string[]>();
  const fetchedAt = new Map<string, number>();
  let pending = false;
  let started = false;

  const union = (): string[] => [...new Set([...[...wanted.values()].flat(), ...d.live()])];

  async function pull(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const at = d.now();
      for (const id of part) fetchedAt.set(id, at);
      try {
        d.apply(await d.fetch(part));
      } catch {
        // 取れなかった行は、次の知らせか周期で取り直す。
        for (const id of part) fetchedAt.delete(id);
      }
    }
  }

  /** 新しく見えた行（直前に取っていないもの）を、少し待ってからまとめて取る。 */
  function soon(): void {
    if (pending) return;
    pending = true;
    d.setTimeout(() => {
      pending = false;
      if (!d.visible()) return;
      const now = d.now();
      const ids = union().filter((id) => now - (fetchedAt.get(id) ?? -Infinity) >= FRESH_MS);
      if (ids.length > 0) void pull(ids);
    }, GIT_BATCH_MS);
  }

  function loop(): void {
    d.setTimeout(() => {
      if (d.visible()) { void pull(union()); d.also?.(); }
      loop();
    }, GIT_POLL_MS);
  }

  function start(): void {
    if (started) return;
    started = true;
    loop();
  }

  return {
    /** 場所（key）の見えている行を置き換える。空の並びで取り下げる。 */
    watch(key: string, ids: string[]): void {
      if (ids.length === 0) wanted.delete(key);
      else wanted.set(key, ids);
      if (ids.length === 0) return;
      // 周期は、最初に見えている行が届いてから始める（何も見ていない間は予約を積まない）。
      start();
      soon();
    },
    /** 周期を始める。二度目からは何もしない。 */
    start,
    /** 窓が前に戻った。覚えを捨てて、見えている行を取り直す。 */
    wake(): void {
      fetchedAt.clear();
      soon();
      d.also?.();
    },
  };
}
