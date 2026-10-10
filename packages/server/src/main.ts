import { runMain } from './entry.ts';
import { takeServerEnv } from './launch/env.ts';
import { startServer } from './server.ts';

// 受け渡しの値を読んでから、受け継いだ Claude Code の印と hangar の受け渡しの変数を自分の環境から消す（launch/env.ts）。
// ほかの何よりも先に行う。サーバが起こす tmux サーバと claude は、この環境を継ぐ。
const handoff = takeServerEnv();
// 止める受け口、親の見張り、起動が転んだときの終わり方は entry.ts の runMain にある。
void runMain({ start: () => startServer({ port: handoff.port, uiDist: handoff.uiDist }), parentPid: handoff.parentPid });
