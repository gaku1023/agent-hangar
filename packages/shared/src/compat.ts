/**
 * 互換の版番号（作り替えの全体計画の D10）。
 *
 * hangar の部品のうち、別々に上がりうるのは、端末どうし（同期で Worker を挟む）、端末と Worker、殻と 4177 のサーバである。
 * それぞれが 1 つの整数を名乗り、相手に下限を持つ（殻と既存のサーバだけは、下限ではなく一致で比べる）。下限より古い相手とは話さずに、理由を出して止まる。
 * UI とサーバと CLI は同じ束で配るので、この番号を持たない。
 *
 * 上げるのは、同期の形、Worker の API、殻とサーバの合図を、古い相手と話せない形で変えるときだけである。
 * 項目を足すだけで古い相手も読める変更では上げない（docs/design.md「互換の版番号」）。
 * 版 2（段 2 の PR 11）：セッションの名前とメモを、sessions の payload ではなく session_notes の行で運ぶ。
 * 版 1 の端末は session_notes を知らずに捨て、名前とメモを sessions の payload に載せるので、混ざると名前とメモが消える。
 *
 * 版 3（段 4 の PR 15）：Worker が、設定の同期の束の行（共有テーブル config_snapshots）を受け取れる。
 * 版 2 までの Worker は、この表の行を含む push を 400 で丸ごと断る。端末は、Worker が名乗る版が CONFIG_BUNDLE_MIN_WORKER_COMPAT に届くまで束の行を送らない。
 * 版 2 の端末は束の行を送らず、ほかの表は今までどおり運ぶので、混ざっても困らない（Worker の下限 MIN_DEVICE_COMPAT は 2 のまま）。
 *
 * 版 4（段 4 の PR 18）：旧実装の設定の同期（項目ごとに R2 の config/<端末>/<相対パス> へ置く方式）を消した。
 * 版 3 までの端末は旧実装を積んでいて、同じ Worker の旧い置き場を使い続ける。版 4 の Worker は、旧い置き場を掃除し、版 4 未満の端末を 426 で断る（MIN_DEVICE_COMPAT を 4 に上げた）。
 *
 * 殻は同梱するサーバと同じ版を名乗る写しを持つ（apps/desktop/src-tauri/src/health.rs の COMPAT_VERSION）。apps/desktop/test/config.test.ts がこの値と突き合わせる。
 * 殻は 4177 の既存のサーバと下限ではなく一致で比べるので、この版を上げると、上げた殻は上げる前のサーバを採らず、上げる前の殻は上げた後のサーバを採らない。
 */
export const COMPAT_VERSION = 4;

/**
 * 設定の同期の束の行（共有テーブル config_snapshots）を受け取れる Worker の版（段 4 の PR 14 で決めた定数）。
 * 配備済みの Worker は、この表の行を含む push を 400 で丸ごと断るので、他の表の同期まで止まる。
 * 端末は、Worker が名乗る版がこの値に届くまで、スイッチが入っていても束の行を書かず、状態に「Worker の更新待ち」を出す。
 * PR 15 が、この表を知る Worker の COMPAT_VERSION をこの値に上げた（Worker を配備すると、端末にこの版が見える）。
 * 端末に求める下限（MIN_DEVICE_COMPAT）と MIN_WORKER_COMPAT は、これでは上げない。上げると配備前の Worker を使う端末が全部止まる。
 */
export const CONFIG_BUNDLE_MIN_WORKER_COMPAT = 3;

/** 版を運ぶ見出し（X-Hangar-Compat）。端末は要求に、Worker は応答に、自分の版を載せる。 */
export const COMPAT_HEADER = 'x-hangar-compat';

/** 要求に足す見出し。サーバの同期の client、CLI、Worker の試験の道具が同じものを使う。 */
export function compatHeaders(): Record<string, string> {
  return { [COMPAT_HEADER]: String(COMPAT_VERSION) };
}

/**
 * 相手が名乗った版を読む。
 * 見出しが無いのは、版番号を入れる前の古い相手である。版 0 として読む。
 * 整数として読めない値（空、負、小数、指数、16 進、桁あふれ）も版 0 にする。相手の言い分を大きく読む向きには倒さない。
 */
export function parseCompat(v: string | null | undefined): number {
  const t = (v ?? '').trim();
  if (!/^\d+$/.test(t)) return 0;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : 0;
}

/** Worker が、下限より古い端末に 426 で返す本文。minCompat は Worker が求める下限、compat は Worker の版である。 */
export type CompatRefusalBody = { error: 'upgrade required'; minCompat: number; compat: number };

export function compatRefusalBody(minCompat: number): CompatRefusalBody {
  return { error: 'upgrade required', minCompat, compat: COMPAT_VERSION };
}

/** 426 の本文から、相手が求める下限を読む。形が違えば null を返す（例外を投げない）。 */
export function readCompatRefusal(text: string): number | null {
  try {
    const v = JSON.parse(text) as Partial<CompatRefusalBody> | null;
    if (!v || v.error !== 'upgrade required') return null;
    const n = v.minCompat;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
