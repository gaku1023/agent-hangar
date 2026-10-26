import { writeFakeNodeTool } from './fake-bin.ts';

/**
 * 実物の codex の代わり。いまは版とログインのふりだけ（app-server と rollout は段 B の後続で足す）。
 * `--version` は `codex-cli <version>` を出して 0 で終わる。`login status` は loggedIn なら 0、でなければ 1（実物と同じく標準エラーへ文を出す）。
 * 起動のたびに、argv と環境変数のキーを logFile に 1 行 1 件の JSON で足す（環境の漏れを試験で見る）。
 */
export type FakeCodexOptions = {
  version?: string;
  loggedIn?: boolean;
  /** 起動の記録の置き場。 */
  logFile?: string;
};

export function writeFakeCodex(dir: string, o: FakeCodexOptions = {}): string {
  const version = o.version ?? '0.164.0';
  const script = `
import fs from 'node:fs';
const args = process.argv.slice(2);
${o.logFile ? `fs.appendFileSync(${JSON.stringify(o.logFile)}, JSON.stringify({ argv: args, env: process.env }) + '\\n');` : ''}
if (args[0] === '--version') { process.stdout.write('codex-cli ${version}\\n'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (${o.loggedIn === false ? 'false' : 'true'}) { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
  process.stderr.write('Not logged in\\n'); process.exit(1);
}
process.stderr.write('fake codex: unsupported ' + args.join(' ') + '\\n'); process.exit(2);
`;
  return writeFakeNodeTool(dir, 'codex', script);
}
