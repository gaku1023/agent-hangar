// opencode の見本を採る（packages/server/test/capture-opencode/run.ts）。
// 本物の opencode を試しの置き場と空の環境で 1 本だけ起こす。LLM は呼ばない（OpenAI 互換の模擬を手元に立てる）ので、使用量は使わない。
// 利用者の opencode の記録と設定には触らない。CI では動かさない（照合は packages/server/test/opencodeLive.test.ts）。
// 使い方：npm run capture-opencode-fixtures（採り直すときは -- --force、試しに別の場所へ書くときは -- --out <ディレクトリ>）
import { main } from '../packages/server/test/capture-opencode/run.ts';

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
