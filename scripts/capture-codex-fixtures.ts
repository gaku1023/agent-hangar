// codex の見本を採る（packages/server/test/capture-codex/run.ts）。
// 本物の codex を試しの置き場と空の環境で動かす。ログインはせず、モデルも使わない（手元の模擬が答える）ので、使用量は使わない。
// 利用者の ~/.codex には触らない。CI では動かさない（照合は packages/server/test/codexLive.test.ts）。
// 使い方：npm run capture-codex-fixtures（採り直すときは -- --force、試しに別の場所へ書くときは -- --out <ディレクトリ>）
import { main } from '../packages/server/test/capture-codex/run.ts';

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
