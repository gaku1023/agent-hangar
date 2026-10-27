import readline from 'node:readline';
import {
  appendStatuslineSnippet,
  ensureHome,
  hangarHome,
  hasStatuslineMarker,
  readOrCreateToken,
  readUtf8Text,
  resolveStatuslineScript,
  statuslineSnippet,
  statuslineSnippetFor,
  statuslineSnippetUpToDate,
  writeStatuslineHeaderFile,
} from '@agent-hangar/server/src/cliEntry.ts';

export type Ask = (question: string) => Promise<boolean>;

/** 端末で y か n を聞く。y と yes だけを承認とみなす。 */
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
 * 追記先が見つからなければ手順を印字して終わり、見つかれば承認を得てからバックアップと追記を行う。
 *
 * どちらの道でも、先に hangar 自身の置き場へヘッダのファイルを置く。
 * スニペットはこのファイルからトークンを読むので、無ければ何も送らずに素通しする。
 * 手で入れる人にも要るものなので、スクリプトが見つからないときも置いておく。
 */
export async function runStatuslineInstall(o: {
  claudeDir: string;
  port: number;
  yes: boolean;
  /** hangar 自身の置き場。テストは一時ディレクトリを渡す。 */
  home?: string;
  ask?: Ask;
  log?: (s: string) => void;
}): Promise<{ installed: boolean; message: string }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const ask = o.ask ?? promptYesNo;
  const home = o.home ?? hangarHome();
  ensureHome(home);
  writeStatuslineHeaderFile(home, readOrCreateToken(home));
  const r = resolveStatuslineScript(o.claudeDir);
  if (!r.scriptPath) {
    log(r.command ? `statusLine.command は「${r.command}」で、ファイルとして見つからないため自動では追記しません。` : 'settings.json に statusLine.command がありません。');
    log('使用量をヘッダーに表示するには、ステータスラインのスクリプトの先頭（shebang の直後）に次を追記してください。');
    log('');
    log(statuslineSnippet(o.port));
    return { installed: false, message: 'スクリプトが見つかりません' };
  }
  // UTF-8 でないスクリプト（UTF-16 など）は、UTF-8 で書き戻すと壊れるので触らない。
  const read = readUtf8Text(r.scriptPath);
  if (read === null || 'problem' in read) {
    log(`${r.scriptPath} が UTF-8 で保存されていない（UTF-16 など）ため、変更しません。UTF-8 で保存し直すか、手動で追記してください。`);
    return { installed: false, message: 'UTF-8 ではないため変更しませんでした' };
  }
  // 目印だけを見て終わると、トークンを argv に載せる古い形が入ったまま残る。中身まで見て差し替える。
  const has = hasStatuslineMarker(read.text);
  if (has && statuslineSnippetUpToDate(r.scriptPath, o.port)) { log('すでに追記されています'); return { installed: true, message: 'すでに追記されています' }; }
  log(`${has ? '差し替え先' : '追記先'}: ${r.scriptPath}`);
  if (has) log('古い形式のスニペットが追記されています。現在の形式に差し替えます。');
  log(`${has ? '差し替える' : '追記する'}内容:`);
  log(statuslineSnippetFor(r.scriptPath, o.port));
  const question = has ? 'この内容に差し替えますか？差し替える前にバックアップを作成します。' : 'この内容を追記しますか？追記する前にバックアップを作成します。';
  if (!o.yes && !(await ask(question))) return { installed: false, message: has ? '差し替えませんでした' : '追記しませんでした' };
  const done = appendStatuslineSnippet(r.scriptPath, o.port);
  if (!done.changed) {
    // 目印はあるのに範囲を読み取れない。手で書き換えられているので、こちらからは触らない。
    log('スニペットの範囲を読み取れなかったため、何も変更しませんでした。手動で置き換えてください。');
    return { installed: true, message: '変更しませんでした' };
  }
  if (done.backup) log(`バックアップ: ${done.backup}`);
  log(`${has ? '差し替えました' : '追記しました'}。次に Claude Code を起動すると、使用量がヘッダーに表示されます。`);
  return { installed: true, message: has ? '差し替えました' : '追記しました' };
}
