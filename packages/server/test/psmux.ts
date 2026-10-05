import { whichMux } from '../src/config/tools.ts';

/** psmux の絶対パス。Windows で psmux があるときだけ値を持つ。無ければ、psmux を相手にする試験を飛ばす。 */
export const PSMUX: string | null = process.platform === 'win32' ? whichMux() : null;

/**
 * 試験ごとの名前空間。利用者の psmux のセッションに触れないよう、必ず -L で分ける。
 * psmux は -S のパスを無視して既定の名前空間に入る。kill-server は名前空間を越えて全部を落とすので呼ばない。
 * 後始末は、作ったセッションを kill-session で 1 つずつ止める。
 */
export function psmuxNamespace(): string {
  return `hangar-test-${process.pid}-${Date.now().toString(36)}`;
}
