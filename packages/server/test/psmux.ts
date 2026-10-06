import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { whichMux } from '../src/config/tools.ts';

/** psmux の絶対パス。Windows で psmux があるときだけ値を持つ。無ければ、psmux を相手にする試験を飛ばす。 */
export const PSMUX: string | null = process.platform === 'win32' ? whichMux() : null;

/**
 * 試験が psmux を起こすときの環境。利用者の psmux のセッションに触れないよう、置き場ごと分ける。
 * - PSMUX_DATA_DIR：psmux がセッションの台帳を置く場所。分けると、利用者の一覧にこちらのセッションは出ず、こちらからも利用者のものは見えない。
 * - PSMUX_NO_WARM：psmux は次の起動を速めるために、名前空間ごとに予備のサーバを 1 つ残す。試験のたびに残ると溜まるので止める。
 * どちらも psmux 3.3.8 で確かめた（2026-10-06）。help には出ないので、psmux を上げたら psmux.win.test.ts の隔離の試験で確かめ直す。
 * kill-server は、それでも呼ばない。後始末は、作ったセッションを kill-session で 1 つずつ止める。
 */
export function psmuxTestEnv(): NodeJS.ProcessEnv {
  return { PSMUX_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-psmux-data-')), PSMUX_NO_WARM: '1' };
}

/** 試験ごとの名前空間。置き場を分けたうえで、名前空間も分ける。 */
export function psmuxNamespace(): string {
  return `hangar-test-${process.pid}-${Date.now().toString(36)}`;
}
