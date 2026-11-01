import path from 'node:path';
import { Command } from 'commander';
import { claudeJsonPath, defaultClaudeDir, defaultCodexHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, zshrcPath } from '@agent-hangar/server/src/cliEntry.ts';
import { runConfigApply, runConfigRestore } from './config.ts';
import { askLine, cloudBackfill, cloudStatus, installUsageToken, OVERWRITE_WORD, promptWord, readJoinCodeInput, readUsageToken, runSetupCloud, runTeardown, USAGE_TOKEN_HELP } from './cloud.ts';
import { devicesCommand, JOIN_TOKEN_RETIRED, joinCheckCommand, joinInteractive, joinPollCommand, joinRequestCommand, leaveCommand, revokeCommand } from './membership.ts';
import { runMcpInstall, runMcpUninstall } from './mcp.ts';
import { readRecoveryKeyInput, runRecover } from './recovery.ts';
import { cliErrorText, probeHealth, serverDownMessage } from './probe.ts';
import { candidatesCommand, projectAddCommand, projectRemoveCommand, workspaceSetCommand, workspaceUnsetCommand } from './project.ts';
import { formatSetupReport, runSetup, whichMuxCmd } from './setup.ts';
import { runShellInstall, runShellUninstall, shellStatusLine } from './shell.ts';
import { headlessServer, runCommand } from './run.ts';
import { runStart } from './start.ts';
import { promptYesNo, runStatuslineInstall } from './statusline.ts';
import { runSetupCommand, setupEnvFor, type SetupCommandFlags, type SetupTarget } from './setupPlan.ts';
import { entryUrl, openedMessage, openFailedMessage, openInBrowser } from './url.ts';

const program = new Command().name('hangar').description('agent-hangar のコマンド');

// setup はサブコマンド（setup cloud）の親でもある。
// commander では親に action を残したまま子を足せるので、既定の動作はこの action のままである。
const setup = program
  .command('setup')
  .description('データディレクトリを用意し、ツールと新しいディレクトリの作成先を確認し、ステータスラインへの追記を提案する')
  .option('--workspace <dir>', '新しいディレクトリの作成先（任意）')
  .option('--yes', 'すべての確認に同意する')
  .option('--skip-statusline', 'ステータスラインへの追記を提案しない')
  .option('--skip-shell', '外部ターミナルの claude を hangar で開けるようにする 1 行を提案しない')
  .action(async (o: { workspace?: string; yes?: boolean; skipStatusline?: boolean; skipShell?: boolean }) => {
    const home = hangarHome();
    const r = runSetup({ home, workspaceRoot: o.workspace });
    console.log(formatSetupReport(r));
    if (!o.skipStatusline && !r.statusline.installed) {
      console.log('');
      const claudeDir = loadSettings(home).claudeDir || defaultClaudeDir();
      await runStatuslineInstall({ claudeDir, port: 4177, yes: o.yes ?? false });
    }
    if (!o.skipShell) {
      // 新しい PC は setup の流れで聞かれるようにする。同期している他の PC は Settings で入っているかが分かる。
      console.log('');
      await runShellInstall({ tmuxPath: tmuxPathFor(home), yes: o.yes ?? false });
    }
    console.log('');
    console.log('MCP サーバーは hangar mcp install で登録できます。');
  });

setup
  .command('cloud')
  .description('自分の Cloudflare アカウントに同期用の Worker、D1、R2 を作成してデプロイする（リポジトリを clone したディレクトリで実行する。アプリに同梱の hangar では作成できない）')
  .option('--name <name>', 'Worker の名前（D1 は同名、R2 は <name>-files）', 'hangar')
  .option('--usage-token', '使用量と料金を表示するための読み取り専用のトークンを Worker に追加する（標準入力から受け取る）')
  .option('--account-id <id>', '作成先の Cloudflare のアカウント ID（アカウントが複数あるとき。CLOUDFLARE_ACCOUNT_ID でも指定できる）')
  .option('--save <path>', 'リカバリーキーをこのファイルにも保存する（0600）')
  .action(async (o: { name: string; usageToken?: boolean; accountId?: string; save?: string }) => {
    const home = hangarHome();
    if (o.usageToken) {
      for (const l of USAGE_TOKEN_HELP) console.log(l);
      await installUsageToken({ home, token: await readUsageToken() });
      return;
    }
    const device = readOrCreateDevice(home);
    await runSetupCloud({ home, device, name: o.name, accountId: o.accountId, ...(o.save ? { saveRecoveryTo: path.resolve(o.save) } : {}) });
  });

program
  .command('recover')
  .description('すべての PC を失ったときに、リカバリーキーでこの PC をクラウド同期に戻す（リカバリーキーは標準入力から読み取る。Worker を作成した Cloudflare アカウントで wrangler を使うので、リポジトリを clone したディレクトリで実行する）')
  .option('--name <name>', 'Worker の名前（デフォルトは workers.dev の URL の先頭のラベル）')
  .option('--account-id <id>', 'Worker を作成した Cloudflare のアカウント ID（アカウントが複数あるとき。CLOUDFLARE_ACCOUNT_ID でも指定できる）')
  .action(async (o: { name?: string; accountId?: string }) => {
    const home = hangarHome();
    // リカバリーキーは argv に載せない。標準入力から受け取る。
    const text = await readRecoveryKeyInput();
    await runRecover({ home, device: readOrCreateDevice(home), text, ...(o.name ? { name: o.name } : {}), ...(o.accountId !== undefined ? { accountId: o.accountId } : {}) });
  });

// 参加トークンは廃止した（参加コードと承認に置き換えた）。
// 古い手順を覚えている人と古い殻のために、コマンドは残して案内だけを出す。引数も標準入力も読まない。
program
  .command('join [args...]')
  .description('廃止しました。hangar cloud join <接続先の URL> を使ってください')
  .allowUnknownOption()
  .action(() => {
    console.log(JOIN_TOKEN_RETIRED);
    process.exitCode = 1;
  });

const cloud = program.command('cloud').description('クラウド同期の管理');

cloud
  .command('join <url>')
  .description('参加コードでクラウド同期に参加する（ターミナルで参加コードを入力し、確認コードを表示して、参加コードを発行した PC の承認を待つ）')
  .action(async (url: string) => {
    if (!process.stdin.isTTY) throw new Error('標準入力が対話型ではないため、参加コードを入力できません。ターミナルから実行してください');
    const home = hangarHome();
    process.exitCode = await joinInteractive({ home, url, device: readOrCreateDevice(home), ask: askLine, confirm: promptWord, overwriteWord: OVERWRITE_WORD });
  });

cloud
  .command('join-check <url>')
  .description('参加する前に接続先を確認する（Worker の互換バージョンと、参加済みの PC の数。デスクトップアプリが使う）')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (url: string, o: { json?: boolean }) => {
    process.exitCode = await joinCheckCommand({ home: hangarHome(), url, json: o.json ?? false });
  });

cloud
  .command('join-request <url>')
  .description('参加リクエストを送信して確認コードを出力する（参加コードは標準入力から読み取る。デスクトップアプリが使う）')
  .option('--overwrite', '別のクラウドに参加済みでも、cloud.json を上書きして参加する')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (url: string, o: { overwrite?: boolean; json?: boolean }) => {
    const home = hangarHome();
    // 参加コードは argv に載せない。標準入力から受け取る。
    const code = await readJoinCodeInput();
    process.exitCode = await joinRequestCommand({ home, url, code, device: readOrCreateDevice(home), overwrite: o.overwrite ?? false, json: o.json ?? false });
  });

cloud
  .command('join-poll')
  .description('参加リクエストの承認を 1 回だけ確認し、承認されていれば cloud.json を書く（デスクトップアプリが 2 秒ごとに使う）')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (o: { json?: boolean }) => {
    process.exitCode = await joinPollCommand({ home: hangarHome(), json: o.json ?? false });
  });

cloud
  .command('status')
  .description('クラウド同期の状態を表示する')
  .option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => {
    console.log(await cloudStatus({ home: hangarHome(), port: Number(o.port) }));
  });

cloud
  .command('backfill')
  .description('参加より前のトランスクリプトもクラウドへアップロードし直す（デフォルトでは、参加より後に更新されたトランスクリプトだけをアップロードする）')
  .action(() => {
    console.log(cloudBackfill({ home: hangarHome() }));
  });

cloud
  .command('devices')
  .description('同期に参加している PC と、解除した PC を一覧表示する（参加日、最終同期の時刻）')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (o: { json?: boolean }) => {
    const home = hangarHome();
    process.exitCode = await devicesCommand({ home, deviceId: readOrCreateDevice(home).id, json: o.json ?? false });
  });

cloud
  .command('revoke <id>')
  .description('他の PC を同期から解除する（その PC 用のトークンを無効にし、暗号鍵を再生成して残りの PC に配布する。hangar の起動中に行う。ID は hangar cloud devices で確認する）')
  .option('--yes', '確認せずに解除する')
  .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）')
  .option('--port <n>', '実行中の hangar のポート', '4177')
  .action(async (id: string, o: { yes?: boolean; json?: boolean; port: string }) => {
    const home = hangarHome();
    process.exitCode = await revokeCommand({ home, deviceId: readOrCreateDevice(home).id, id, yes: o.yes ?? false, json: o.json ?? false, port: Number(o.port), confirm: promptWord });
  });

cloud
  .command('leave')
  .description('この PC の参加を解除する（cloud.json を削除し、デフォルトでクラウドの一覧でもこの PC を解除する）')
  .option('--keep-device', 'クラウドの一覧ではこの PC を解除しない（この PC 用のトークンを無効にしない）')
  .option('--yes', '確認せずに解除する')
  .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）')
  .action(async (o: { keepDevice?: boolean; yes?: boolean; json?: boolean }) => {
    const home = hangarHome();
    process.exitCode = await leaveCommand({ home, deviceId: readOrCreateDevice(home).id, revoke: !o.keepDevice, yes: o.yes ?? false, json: o.json ?? false, confirm: promptWord });
  });

cloud
  .command('teardown')
  .description('Worker、D1、R2 を削除する（元に戻せない。削除する前に R2 のトランスクリプトをこの PC にダウンロードする）')
  .action(async () => {
    const home = hangarHome();
    const ok = await runTeardown({
      home,
      deviceId: readOrCreateDevice(home).id,
      claudeDir: loadSettings(home).claudeDir || defaultClaudeDir(),
      // Codex の会話の原本の置き場（索引と同じ、CODEX_HOME か ~/.codex）。
      codexHome: defaultCodexHome(),
      confirm: promptWord,
    });
    if (!ok) process.exitCode = 1;
  });

program
  .command('start')
  .description('サーバーを起動する')
  .option('--port <n>', 'ポート', '4177')
  .option('--no-open', 'ブラウザを開かない')
  .action(async (o: { port: string; open: boolean }) => {
    const port = Number(o.port);
    // サーバは子プロセスで起こす（start.ts）。CLI がサーバのコードを import すると、cli.mjs にサーバが二重に入る。
    process.exitCode = await runStart({
      port,
      onReady: () => {
        // 鍵は端末にだけ印字する。サーバのログには載せない。見直したくなったら hangar url で出せる。
        const url = entryUrl(port, readOrCreateToken(hangarHome()));
        console.log('');
        console.log(`この URL から開いてください: ${url}`);
        console.log('トークンはページを開いた時点でクッキーに変わり、URL からは消えます。以後はブックマークから開けます。');
        console.log('この URL をもう一度表示するには hangar url を実行してください。');
        if (o.open) openInBrowser(url);
      },
    });
  });

program
  .command('status')
  .description('サーバーの状態を表示する')
  .option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => {
    try {
      const r = await fetch(`http://127.0.0.1:${o.port}/health`);
      console.log(await r.text());
    } catch {
      console.log('停止しています');
      process.exitCode = 1;
    }
  });

program
  .command('url')
  .description('トークン付きの URL を出力する（ブラウザは開かない）')
  .option('--port <n>', 'ポート', '4177')
  .action((o: { port: string }) => {
    // 起動の後にこの URL を見直す唯一の道である。
    // 別のブラウザで開きたいときや、`open` の効かない環境でもここから貼れる。
    // サーバの生死は見ない。止まっていても控えておきたいことがあるためである。
    console.log(entryUrl(Number(o.port), readOrCreateToken(hangarHome())));
  });

program
  .command('open')
  .description('ブラウザで UI を開く')
  .option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => {
    const port = Number(o.port);
    // 居ないサーバのページを黙って開いても、真っ白な失敗しか見えない。先に確かめる。
    if (!(await probeHealth(port))) {
      console.error(serverDownMessage(port));
      process.exitCode = 1;
      return;
    }
    // 鍵付きで開く。クッキーを持っているブラウザなら鍵は使われず、そのまま開く。
    // 鍵は端末に出さない。出すと、画面の表示とシェルの履歴に残る。ブラウザへだけ渡す。
    // 鍵は argv にも載せない。openInBrowser が標準入力（または本人だけが読めるファイル）から渡す。
    // 開けなかったときも鍵は出さず、鍵の無い URL と hangar url の案内だけを出す。
    const url = entryUrl(port, readOrCreateToken(hangarHome()));
    console.log((await openInBrowser(url)) ? openedMessage(port) : openFailedMessage(port));
  });

// スクリプトから会話を動かす入口。動いているサーバが無ければ、画面なしで起こして終わりに止める。
// 終了の符号は run.ts の EXIT（0 終わった、1 失敗、2 サーバを使えない、3 時間切れ、4 入力待ち）。
program
  .command('run [prompt]')
  .description('会話を作るか既存の会話に送り、ターンの終わりか入力待ちまで待って結果を返す（終了コード: 0 終わった、1 失敗、2 サーバーを使えない、3 時間切れ、4 入力待ち）')
  .option('--session <id>', '新しく作らず、この会話に送る（プロンプトを省くと待つだけ）')
  .option('--project <id|path>', '新しい会話のプロジェクト（省くと作業ディレクトリから決める）')
  .option('--agent <agent>', 'エージェント（claude-code、codex、opencode）')
  .option('--model <model>', 'モデル')
  .option('--effort <effort>', '推論の段階')
  .option('--permission-mode <mode>', '権限モード')
  .option('--name <name>', '会話の名前')
  .option('--timeout <seconds>', '待つ上限（秒）', '1800')
  .option('--json', '結果を 1 行の JSON で出す')
  .option('--port <n>', 'ポート', '4177')
  .action(async (promptArg: string | undefined, o: { session?: string; project?: string; agent?: string; model?: string; effort?: string; permissionMode?: string; name?: string; timeout: string; json?: boolean; port: string }) => {
    const timeoutSeconds = Number(o.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      console.error('--timeout は 0 以上の秒数で指定してください。');
      process.exitCode = 1;
      return;
    }
    // - は標準入力から読む。長いプロンプトをシェルの引用から逃がすためである。
    let prompt = promptArg;
    if (prompt === '-') {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      prompt = Buffer.concat(chunks).toString('utf8');
    }
    const home = hangarHome();
    const port = Number(o.port);
    const server = headlessServer({ port, home });
    // Ctrl-C で待ちをやめても、起こしたサーバを残さない。会話は tmux で動き続ける。
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void server.stop().finally(() => process.exit(130)); });
    process.exitCode = await runCommand({
      port, token: readOrCreateToken(home), json: o.json ?? false, timeoutSeconds, cwd: process.cwd(), prompt: prompt?.trim() ? prompt : undefined, server,
      ...(o.session ? { session: o.session } : {}), ...(o.project ? { project: o.project } : {}), ...(o.agent ? { agent: o.agent } : {}), ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}), ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}), ...(o.name ? { name: o.name } : {}),
    });
  });

// プロジェクトの候補と登録（セットアップのすゝめ、2026-10-15）。
// Claude Code が Bash から叩くので、対話の問いは作らない。
// 書く前の見せ方は --dry-run だけで、承認は Claude の会話の中で取る。
// どれも動いているサーバの API を鍵付きで呼び、サーバは起こさない。
// 終了の符号は、全部成功が 0、一部でも失敗が 1、サーバが止まっているときが 2 である。
const apiOptions = (o: { port: string; json?: boolean }) => ({ port: Number(o.port), token: readOrCreateToken(hangarHome()), json: o.json ?? false });

const project = program.command('project').description('プロジェクトの候補と登録（実行中のサーバーに依頼する）');

project
  .command('candidates')
  .description('Claude Code と会話した、まだプロジェクトに登録していないディレクトリの候補を一覧表示する（1 行 1 候補）')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (o: { port: string; json?: boolean }) => {
    process.exitCode = await candidatesCommand(apiOptions(o));
  });

project
  .command('add <paths...>')
  .description('ディレクトリをプロジェクトに登録する（登録済みは成功のまま already。入れ子は登録しない）')
  .option('--dry-run', '書き込まずに、登録する名前、関連付ける会話の数、登録できないものを表示する')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (paths: string[], o: { port: string; json?: boolean; dryRun?: boolean }) => {
    process.exitCode = await projectAddCommand({ ...apiOptions(o), paths, dryRun: o.dryRun ?? false });
  });

project
  .command('remove <target>')
  .description('プロジェクトを一覧から削除する（パスか id で指定する。会話は未分類に戻り、トランスクリプトとディレクトリは削除しない）')
  .option('--dry-run', '書き込まずに、未分類に戻る会話の数と、他の PC に影響するかを表示する')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (target: string, o: { port: string; json?: boolean; dryRun?: boolean }) => {
    process.exitCode = await projectRemoveCommand({ ...apiOptions(o), target, dryRun: o.dryRun ?? false });
  });

const workspace = program.command('workspace').description('新しいディレクトリの作成先（実行中のサーバーに依頼する）');

workspace
  .command('set <dir>')
  .description('新しいディレクトリの作成先を設定する（保存すると、直下の会話のあるディレクトリを自動で登録する）')
  .option('--dry-run', '書き込まずに、自動で登録される直下のディレクトリをすべて表示する')
  .option('--trust', '新しいディレクトリの作成先と直下のリポジトリを Claude Code の信頼済みにする（ユーザーの同意を得てから指定する）')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (dir: string, o: { port: string; json?: boolean; dryRun?: boolean; trust?: boolean }) => {
    process.exitCode = await workspaceSetCommand({ ...apiOptions(o), dir, dryRun: o.dryRun ?? false, trust: o.trust ?? false });
  });

workspace
  .command('unset')
  .description('新しいディレクトリの作成先を空にする（登録済みのプロジェクトは残る）')
  .option('--dry-run', '書き込まずに、現在の作成先と、空にしたときに変わることを表示する')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出力する')
  .action(async (o: { port: string; json?: boolean; dryRun?: boolean }) => {
    process.exitCode = await workspaceUnsetCommand({ ...apiOptions(o), dryRun: o.dryRun ?? false });
  });

const mcp = program.command('mcp').description('Claude Code への MCP 登録');

mcp
  .command('install')
  .description('user スコープに hangar を登録する（~/.claude.json の mcpServers.hangar に書き込む。書き込む前にバックアップを作成する）')
  .option('--port <n>', 'ポート', '4177')
  .option('--dry-run', '書き込まずに、書き込み先と差分だけを表示する')
  .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）。書き込むには --yes が必要')
  .option('--yes', '確認せずに書き込む（--json のとき）')
  .option('--expect <fingerprint>', 'プレビューのフィンガープリント。表示した後に書き込み先が変わっていたら書き込まない（デスクトップアプリが使う）')
  .action(async (o: { port: string } & SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('mcp-install', Number(o.port), o); return; }
    const r = await runMcpInstall({ home: hangarHome(), port: Number(o.port), claudeJson: claudeJsonPath() });
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
  });

mcp
  .command('uninstall')
  .description('user スコープの hangar を削除する（書き込む前にバックアップを作成する）')
  .option('--dry-run', '書き込まずに、書き込み先と差分だけを表示する')
  .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）。書き込むには --yes が必要')
  .option('--yes', '確認せずに書き込む（--json のとき）')
  .option('--expect <fingerprint>', 'プレビューのフィンガープリント。表示した後に書き込み先が変わっていたら書き込まない（デスクトップアプリが使う）')
  .action(async (o: SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('mcp-uninstall', 4177, o); return; }
    const r = await runMcpUninstall({ home: hangarHome(), claudeJson: claudeJsonPath() });
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
  });

/** hangar が使う tmux。Settings の tmuxPath、無ければ PATH（Windows では psmux を先に見る）。 */
function tmuxPathFor(home: string): string | null {
  return loadSettings(home).tmuxPath ?? whichMuxCmd();
}

/** 連携の書き込みの、--dry-run と --json と --expect の道（setupPlan.ts）。殻の承認の窓が使う。 */
function setupCommand(target: SetupTarget, port: number, flags: SetupCommandFlags): Promise<number> {
  const home = hangarHome();
  const env = setupEnvFor({ home, claudeDir: loadSettings(home).claudeDir || defaultClaudeDir(), claudeJson: claudeJsonPath(), zshrc: zshrcPath(), port, tmuxPath: tmuxPathFor(home) });
  return runSetupCommand(target, env, flags, { ask: promptYesNo });
}

/** 連携の書き込みの旗。殻の承認の窓が使う。 */
function setupFlags(c: Command): Command {
  return c
    .option('--dry-run', '書き込まずに、書き込み先と差分だけを表示する')
    .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）。書き込むには --yes が必要')
    .option('--expect <fingerprint>', 'プレビューのフィンガープリント。表示した後に書き込み先が変わっていたら書き込まない（デスクトップアプリが使う）');
}

const shell = program.command('shell').description('外部ターミナル（VS Code など）で起動した claude を hangar で開けるようにする');

setupFlags(shell
  .command('install')
  .description('~/.zshrc に 1 行を追加し、claude を hangar の tmux の中で起動して接続するようにラップする（確認を求め、バックアップを作成する）')
  .option('--yes', '確認せずに追加する'))
  .action(async (o: SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('shell-install', 4177, o); return; }
    const r = await runShellInstall({ tmuxPath: tmuxPathFor(hangarHome()), yes: o.yes ?? false });
    if (!r.installed) process.exitCode = 1;
  });

setupFlags(shell
  .command('uninstall')
  .description('~/.zshrc から hangar が追加した行を削除する（バックアップを作成する）')
  .option('--yes', '確認せずに削除する（--json のとき）'))
  .action(async (o: SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('shell-uninstall', 4177, o); return; }
    runShellUninstall();
  });

shell
  .command('status')
  .description('この PC にインストールされているかを表示する')
  .action(() => { console.log(shellStatusLine({ tmuxPath: tmuxPathFor(hangarHome()) })); });

const config = program.command('config').description('Claude Code の設定の同期（他の PC から受信した設定を適用する、バックアップの世代に戻す）');

config
  .command('apply')
  .description('保存した適用内容を読み取り、件数と種類を表示して承認を得てから、バックアップを作成して各エージェントの設定ディレクトリ（~/.claude、~/.codex など）に書き込む（書き込んだら適用内容を削除する）')
  .option('--yes', '確認せずに書き込む')
  .option('--plan', '書き込まずに、何をどれだけ書き込むかだけを表示する')
  .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）')
  .option('--order <createdAt>', '確認した適用内容の保存時刻。別の適用内容に変わっていたら書き込まない（デスクトップアプリが使う）')
  .option('--dry-run', '--plan と同じ（書き込まずに、書き込み先と差分だけを表示する）')
  .option('--expect <fingerprint>', 'プレビューのフィンガープリント。表示した後に書き込み先が変わっていたら書き込まない（デスクトップアプリが使う）')
  .action(async (o: { yes?: boolean; plan?: boolean; dryRun?: boolean; json?: boolean; order?: string; expect?: string }) => {
    const order = o.order === undefined ? undefined : Number(o.order);
    if (order !== undefined && !Number.isFinite(order)) throw new Error('--order には適用内容の保存時刻（数値）を指定してください');
    process.exitCode = await runConfigApply({ yes: o.yes, plan: o.plan || o.dryRun, json: o.json, order, expect: o.expect });
  });

config
  .command('restore [generation]')
  .description('バックアップの世代に戻す。世代を省くと一覧を表示する。戻す前の状態も新しい世代としてバックアップする')
  .option('--yes', '確認せずに戻す')
  .option('--plan', '戻さずに、書き戻すファイルと削除するファイルだけを表示する')
  .option('--json', '結果を JSON で 1 行出力する（デスクトップアプリが読み取る）')
  .option('--dry-run', '--plan と同じ（戻さずに、書き込み先と差分だけを表示する）')
  .option('--expect <fingerprint>', 'プレビューのフィンガープリント。表示した後に書き込み先が変わっていたら戻さない（デスクトップアプリが使う）')
  .option('--target <target>', '世代の対象（claude、codex、opencode、agents-skills）。省略時は claude')
  .action(async (generation: string | undefined, o: { yes?: boolean; plan?: boolean; dryRun?: boolean; json?: boolean; expect?: string; target?: string }) => {
    process.exitCode = await runConfigRestore({ name: generation, target: o.target, yes: o.yes, plan: o.plan || o.dryRun, json: o.json, expect: o.expect });
  });

const statusline = program.command('statusline').description('ステータスラインのスクリプトへの追記');

setupFlags(statusline
  .command('install')
  .description('使用量をサーバーへ渡すスニペットをステータスラインのスクリプトに追記する（確認を求め、バックアップを作成する）')
  .option('--port <n>', 'ポート', '4177')
  .option('--yes', '確認せずに追記する'))
  .action(async (o: { port: string } & SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('statusline-install', Number(o.port), o); return; }
    const claudeDir = loadSettings(hangarHome()).claudeDir || defaultClaudeDir();
    const r = await runStatuslineInstall({ claudeDir, port: Number(o.port), yes: o.yes ?? false });
    if (!r.installed) process.exitCode = 1;
  });

setupFlags(statusline
  .command('uninstall')
  .description('ステータスラインのスクリプトから hangar が追加した行を削除する（確認を求め、バックアップを作成する）')
  .option('--yes', '確認せずに削除する'))
  .action(async (o: SetupCommandFlags) => {
    process.exitCode = await setupCommand('statusline-uninstall', 4177, o);
  });

// どのコマンドの失敗でも、端末には 1 行だけ出す。生のスタックは読み手の役に立たない。
// ただし wrangler の失敗のように理由が後ろの行にあるもの（DetailedError）は、整えた複数行をそのまま出す。
program.parseAsync(process.argv).catch((e) => {
  console.error(cliErrorText(e));
  process.exit(1);
});
