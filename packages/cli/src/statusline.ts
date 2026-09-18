import fs from 'node:fs';
import readline from 'node:readline';
import { appendStatuslineSnippet, resolveStatuslineScript, STATUSLINE_MARKER, statuslineSnippet } from '@agent-hangar/server';

export type Ask = (question: string) => Promise<boolean>;

/** 端末で y か n を聞く。y と yes だけを承諾とみなす。 */
export function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    }),
  );
}

/**
 * statusline スクリプトへスニペットを追記する。
 * 追記先が見つからなければ手順を印字して終わり、見つかれば承諾を得てからバックアップと追記を行う。
 */
export async function runStatuslineInstall(o: {
  claudeDir: string;
  port: number;
  yes: boolean;
  ask?: Ask;
  log?: (s: string) => void;
}): Promise<{ installed: boolean; message: string }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const ask = o.ask ?? promptYesNo;
  const r = resolveStatuslineScript(o.claudeDir);
  if (!r.scriptPath) {
    log(r.command ? `statusLine.command は「${r.command}」で、ファイルとして見つからないため自動では追記しません。` : 'settings.json に statusLine.command がありません。');
    log('使用量をヘッダーに出すには、statusline スクリプトの先頭（shebang の直後）に次を入れてください。');
    log('');
    log(statuslineSnippet(o.port));
    return { installed: false, message: 'スクリプトが見つかりません' };
  }
  if (fs.readFileSync(r.scriptPath, 'utf8').includes(STATUSLINE_MARKER)) { log('既に追記されています'); return { installed: true, message: '既に追記されています' }; }
  log(`追記先: ${r.scriptPath}`);
  log('追記する内容:');
  log(statuslineSnippet(o.port));
  if (!o.yes && !(await ask('この内容を追記しますか？追記前にバックアップを取ります。'))) return { installed: false, message: '追記しませんでした' };
  const done = appendStatuslineSnippet(r.scriptPath, o.port);
  if (done.backup) log(`バックアップ: ${done.backup}`);
  log('追記しました。次に Claude Code を起動すると、使用量がヘッダーに出ます。');
  return { installed: true, message: '追記しました' };
}
