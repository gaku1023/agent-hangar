import type { MiddlewareHandler } from 'hono';
import { COMPAT_HEADER, COMPAT_VERSION, compatRefusalBody, parseCompat } from '@agent-hangar/shared';
import type { Env, Vars } from './env.ts';

/**
 * 端末に求める互換の版の下限。
 * 段 1 の PR 6 で 1 に上げた。版の見出しを持たない古い端末（版 0 として読む）は 426 で断る。
 * 段 2 の PR 11 で 2 に上げた。版 1 の端末は、セッションの名前とメモを sessions の payload に載せ、session_notes の行を知らずに捨てる。
 * 版 2 の端末と混ざると名前とメモが消えるので、版 1 の端末は 426 で断る。
 * 段 4 の PR 18 で 4 に上げた。版 3 の端末は旧実装の設定の同期を積んでいて、旧実装が R2 に置いた項目ごとの設定（config/<端末>/<相対パス>）を置き直し続ける。
 * 同じ版の Worker は、それらを消す掃除（cleanup.ts の cleanupLegacyConfig。関門は開けた）を走らせるので、旧実装を持たない版 4 の端末だけを通す。
 * 上げるのは、同期に参加しているすべての端末が、その版を名乗る版に上がってからである（docs/design.md「互換の版番号」）。
 * packages/server/test/fake-cloud.test.ts がこの行を文字列で読んで、偽物の写しと突き合わせる。
 */
export const MIN_DEVICE_COMPAT = 4;

/**
 * 互換の版の関所。どの経路よりも先に通す。
 *
 * 下限より古い端末には 426 と下限を返し、スキーマの用意にも認証にも進まない。断った要求で D1 に触らないためである。
 * /health だけは版を問わずに通す。版を確かめに来る口だからである（CLI の status と、setup の反映待ち）。
 * どの応答にも、断ったものを含めて、Worker の版を見出しで載せる。
 */
export function compatMiddleware(minDeviceCompat: number): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    if (c.req.path !== '/health' && parseCompat(c.req.header(COMPAT_HEADER)) < minDeviceCompat) {
      c.header(COMPAT_HEADER, String(COMPAT_VERSION));
      return c.json(compatRefusalBody(minDeviceCompat), 426);
    }
    await next();
    // 経路が自分で組んだ応答（R2 の本文をそのまま返す GET /files/<key>）と、onError と notFound の応答にも載せるため、
    // 出来上がった後で足す。Hono は出来上がった応答の見出しを書き換えるときに、応答を作り直して本文を引き継ぐ。
    c.header(COMPAT_HEADER, String(COMPAT_VERSION));
  };
}
