// Claude Code の見本を採る（packages/server/test/capture/run.ts）。
// 本物の claude を動かすので、Claude の使用量を少し使う。動かす前に利用者に聞く。CI では動かさない。
// 数分かかるので、前面の短い時間切れのある場所（時間切れで SIGKILL される呼び出しなど）では動かさない。SIGINT、SIGTERM、SIGHUP は受けて後始末をする。
// 使い方：npm run capture-claude-fixtures（採り直すときは npm run capture-claude-fixtures -- --force）
import { main } from '../packages/server/test/capture/run.ts';

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
