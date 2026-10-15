import { Command } from 'commander';
import { claudeJsonPath, defaultClaudeDir, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, zshrcPath } from '@agent-hangar/server/src/cliEntry.ts';
import { runConfigApply, runConfigRestore } from './config.ts';
import { cloudBackfill, cloudStatus, installUsageToken, promptWord, readJoinToken, readUsageToken, runJoin, runSetupCloud, runTeardown, USAGE_TOKEN_HELP } from './cloud.ts';
import { devicesCommand, joinCommand, leaveCommand, revokeCommand } from './membership.ts';
import { runMcpInstall, runMcpUninstall } from './mcp.ts';
import { cliErrorText, probeHealth, serverDownMessage } from './probe.ts';
import { candidatesCommand, projectAddCommand, projectRemoveCommand, workspaceSetCommand, workspaceUnsetCommand } from './project.ts';
import { formatSetupReport, runSetup, whichMuxCmd } from './setup.ts';
import { runShellInstall, runShellUninstall, shellStatusLine } from './shell.ts';
import { runStart } from './start.ts';
import { promptYesNo, runStatuslineInstall } from './statusline.ts';
import { runSetupCommand, setupEnvFor, type SetupCommandFlags, type SetupTarget } from './setupPlan.ts';
import { entryUrl, openedMessage, openFailedMessage, openInBrowser } from './url.ts';

const program = new Command().name('hangar').description('agent-hangar のコマンド');

// setup はサブコマンド（setup cloud）の親でもある。
// commander では親に action を残したまま子を足せるので、既定の動作はこの action のままである。
const setup = program
  .command('setup')
  .description('データディレクトリを用意し、ツールとワークスペースを確認し、statusline への追記を提案する')
  .option('--workspace <dir>', '新しいフォルダの作成場所（任意）')
  .option('--yes', '問いかけをすべて承諾する')
  .option('--skip-statusline', 'statusline への追記を提案しない')
  .option('--skip-shell', '外のターミナルの claude を hangar で開けるようにする 1 行を提案しない')
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
    console.log('MCP の登録は hangar mcp install で行えます。');
  });

setup
  .command('cloud')
  .description('自分の Cloudflare アカウントに同期用の Worker と D1 と R2 を作ってデプロイする（リポジトリを clone した場所で実行します。アプリに入っている hangar では作れません）')
  .option('--name <name>', 'Worker の名前（D1 は同名、R2 は <name>-files）', 'hangar')
  .option('--rotate-secret', '参加用の秘密を作り直す（既存の暗号化ファイルが復号できなくなる。確認を求める）')
  .option('--usage-token', '使用量と費用を出す読み取り専用のトークンを Worker に入れる（標準入力から受け取る）')
  .option('--account-id <id>', '作る先の Cloudflare のアカウント ID（アカウントが複数あるとき。CLOUDFLARE_ACCOUNT_ID でも指定できる）')
  .action(async (o: { name: string; rotateSecret?: boolean; usageToken?: boolean; accountId?: string }) => {
    const home = hangarHome();
    if (o.usageToken) {
      for (const l of USAGE_TOKEN_HELP) console.log(l);
      await installUsageToken({ home, token: await readUsageToken() });
      return;
    }
    const device = readOrCreateDevice(home);
    await runSetupCloud({ home, device, name: o.name, rotateSecret: o.rotateSecret, accountId: o.accountId });
  });

program
  .command('join [token]')
  .description('参加トークンでクラウド同期に参加する（トークンは引数を省くと標準入力から受け取る）')
  .option('--force', '確認を省いて参加する（既存の cloud.json も上書きする）')
  .option('--plan', '参加せずに、宛先といまの参加との違いだけを出す（殻の命令が読む）')
  .option('--yes', '宛先の確認を省いて参加する（確認を画面で済ませたとき。殻の命令が使う）。別のクラウドへの上書きは --overwrite が無ければ断る')
  .option('--overwrite', '--yes と一緒に使い、別のクラウドに参加済みでも上書きして参加する')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）')
  .action(async (token: string | undefined, o: { force?: boolean; plan?: boolean; yes?: boolean; overwrite?: boolean; json?: boolean }) => {
    // 秘密は argv に載せない。引数で渡されたときは、残ることを伝える。
    if (token !== undefined && !o.json) {
      console.log('注意: 参加トークンを引数で渡しました。ps とシェルの履歴に残ります。次からは引数なしの hangar join を使ってください。');
    }
    const home = hangarHome();
    // 殻の命令は、参加トークンを標準入力で渡し、宛先の確認は画面で済ませてある。
    if (o.plan || o.yes || o.json) {
      const t = token ?? (await readJoinToken());
      process.exitCode = await joinCommand({ home, token: t, device: readOrCreateDevice(home), plan: o.plan ?? false, yes: o.yes ?? false, overwrite: o.overwrite ?? false, json: o.json ?? false });
      return;
    }
    // 確認は標準入力で取る。トークンを流し込んだ後の標準入力ではもう聞けないので、先に断る。
    if (!process.stdin.isTTY && !o.force) {
      throw new Error('標準入力が対話ではないので確認を取れません。端末から実行するか、--force を付けてください');
    }
    const t = token ?? (await readJoinToken());
    await runJoin({ home, token: t, device: readOrCreateDevice(home), force: o.force, confirm: promptWord });
  });

const cloud = program.command('cloud').description('クラウド同期の管理');

cloud
  .command('status')
  .description('クラウド同期の状態を表示する')
  .option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => {
    console.log(await cloudStatus({ home: hangarHome(), port: Number(o.port) }));
  });

cloud
  .command('backfill')
  .description('参加より前の本文もクラウドへ上げ直す（既定では、参加より後に動いた本文だけを上げる）')
  .action(() => {
    console.log(cloudBackfill({ home: hangarHome() }));
  });

cloud
  .command('devices')
  .description('同期に参加している PC と、解除した PC を一覧する（参加日、最後に同期した時刻と IP とおおよその場所）')
  .option('--json', '結果を JSON で 1 行出す')
  .action(async (o: { json?: boolean }) => {
    const home = hangarHome();
    process.exitCode = await devicesCommand({ home, deviceId: readOrCreateDevice(home).id, json: o.json ?? false });
  });

cloud
  .command('revoke <id>')
  .description('ほかの PC を同期から解除する（その PC の端末トークンを無効にする。ID は hangar cloud devices で調べる）')
  .option('--yes', '問わずに解除する')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）')
  .action(async (id: string, o: { yes?: boolean; json?: boolean }) => {
    const home = hangarHome();
    process.exitCode = await revokeCommand({ home, deviceId: readOrCreateDevice(home).id, id, yes: o.yes ?? false, json: o.json ?? false, confirm: promptWord });
  });

cloud
  .command('leave')
  .description('この PC の参加を解除する（cloud.json を削除し、既定でクラウドの一覧でもこの PC を解除する）')
  .option('--keep-device', 'クラウドの一覧ではこの PC を解除しない（端末トークンを無効にしない）')
  .option('--yes', '問わずに解除する')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）')
  .action(async (o: { keepDevice?: boolean; yes?: boolean; json?: boolean }) => {
    const home = hangarHome();
    process.exitCode = await leaveCommand({ home, deviceId: readOrCreateDevice(home).id, revoke: !o.keepDevice, yes: o.yes ?? false, json: o.json ?? false, confirm: promptWord });
  });

cloud
  .command('teardown')
  .description('Worker と D1 と R2 を消す（取り消せない。消す前に R2 の本文を手元へ降ろす）')
  .action(async () => {
    const home = hangarHome();
    const ok = await runTeardown({
      home,
      deviceId: readOrCreateDevice(home).id,
      claudeDir: loadSettings(home).claudeDir || defaultClaudeDir(),
      confirm: promptWord,
    });
    if (!ok) process.exitCode = 1;
  });

program
  .command('start')
  .description('サーバを起動する')
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
        console.log('鍵はページを開いた時点でクッキーに変わり、URL からは消えます。以後はブックマークから開けます。');
        console.log('この URL を出し直すには hangar url を実行してください。');
        if (o.open) openInBrowser(url);
      },
    });
  });

program
  .command('status')
  .description('サーバの状態を表示する')
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
  .description('鍵付きの URL を印字する（ブラウザは開かない）')
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

// プロジェクトの候補と登録（セットアップのすゝめ、2026-10-15）。
// Claude Code が Bash から叩くので、対話の問いは作らない。
// 書く前の見せ方は --dry-run だけで、承諾は Claude の会話の中で取る。
// どれも動いているサーバの API を鍵付きで呼び、サーバは起こさない。
// 終了の符号は、全部成功が 0、一部でも失敗が 1、サーバが止まっているときが 2 である。
const apiOptions = (o: { port: string; json?: boolean }) => ({ port: Number(o.port), token: readOrCreateToken(hangarHome()), json: o.json ?? false });

const project = program.command('project').description('プロジェクトの候補と登録（動いているサーバに頼む）');

project
  .command('candidates')
  .description('Claude Code と会話した、まだプロジェクトに入っていないフォルダの候補を一覧する（1 行 1 候補）')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出す')
  .action(async (o: { port: string; json?: boolean }) => {
    process.exitCode = await candidatesCommand(apiOptions(o));
  });

project
  .command('add <paths...>')
  .description('フォルダをプロジェクトに登録する（登録済みは成功のまま already。入れ子は断る）')
  .option('--dry-run', '書かずに、登録する名前、紐づく会話の数、断られるものを出す')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出す')
  .action(async (paths: string[], o: { port: string; json?: boolean; dryRun?: boolean }) => {
    process.exitCode = await projectAddCommand({ ...apiOptions(o), paths, dryRun: o.dryRun ?? false });
  });

project
  .command('remove <target>')
  .description('プロジェクトを一覧から削除する（パスか id で選ぶ。会話は未分類に戻り、本文とフォルダは消えない）')
  .option('--dry-run', '書かずに、未分類に戻る会話の数と、ほかの PC に及ぶかを出す')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出す')
  .action(async (target: string, o: { port: string; json?: boolean; dryRun?: boolean }) => {
    process.exitCode = await projectRemoveCommand({ ...apiOptions(o), target, dryRun: o.dryRun ?? false });
  });

const workspace = program.command('workspace').description('新しいフォルダの作成場所（動いているサーバに頼む）');

workspace
  .command('set <dir>')
  .description('作成場所を決める（保存すると、直下の会話のあるフォルダを自動で登録する）')
  .option('--dry-run', '書かずに、自動で登録される直下のフォルダを全部出す')
  .option('--trust', '作成場所と直下のリポジトリを Claude Code の信頼済みにする（利用者の同意を取ってから付ける）')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出す')
  .action(async (dir: string, o: { port: string; json?: boolean; dryRun?: boolean; trust?: boolean }) => {
    process.exitCode = await workspaceSetCommand({ ...apiOptions(o), dir, dryRun: o.dryRun ?? false, trust: o.trust ?? false });
  });

workspace
  .command('unset')
  .description('作成場所を空にする（登録済みのプロジェクトは残る）')
  .option('--dry-run', '書かずに、いまの作成場所と、空にしたときに何が変わるかを出す')
  .option('--port <n>', 'ポート', '4177')
  .option('--json', '結果を JSON で 1 行出す')
  .action(async (o: { port: string; json?: boolean; dryRun?: boolean }) => {
    process.exitCode = await workspaceUnsetCommand({ ...apiOptions(o), dryRun: o.dryRun ?? false });
  });

const mcp = program.command('mcp').description('Claude Code への MCP 登録');

mcp
  .command('install')
  .description('user スコープに hangar を登録する（~/.claude.json の mcpServers.hangar を書く。書く前にバックアップを取る）')
  .option('--port <n>', 'ポート', '4177')
  .option('--dry-run', '書かずに、書く先と差分だけを出す')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）。書くときは --yes が要る')
  .option('--yes', '問わずに書く（--json のとき）')
  .option('--expect <fingerprint>', '見立ての指紋。見せた後に書く先が変わっていたら書かない（殻の命令が使う）')
  .action(async (o: { port: string } & SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('mcp-install', Number(o.port), o); return; }
    const r = await runMcpInstall({ home: hangarHome(), port: Number(o.port), claudeJson: claudeJsonPath() });
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
  });

mcp
  .command('uninstall')
  .description('user スコープの hangar を削除する（書く前にバックアップを取る）')
  .option('--dry-run', '書かずに、書く先と差分だけを出す')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）。書くときは --yes が要る')
  .option('--yes', '問わずに書く（--json のとき）')
  .option('--expect <fingerprint>', '見立ての指紋。見せた後に書く先が変わっていたら書かない（殻の命令が使う）')
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

/** 連携の書き込みの、--dry-run と --json と --expect の道（setupPlan.ts）。殻の承諾の窓が使う。 */
function setupCommand(target: SetupTarget, port: number, flags: SetupCommandFlags): Promise<number> {
  const home = hangarHome();
  const env = setupEnvFor({ home, claudeDir: loadSettings(home).claudeDir || defaultClaudeDir(), claudeJson: claudeJsonPath(), zshrc: zshrcPath(), port, tmuxPath: tmuxPathFor(home) });
  return runSetupCommand(target, env, flags, { ask: promptYesNo });
}

/** 連携の書き込みの旗。殻の承諾の窓が使う。 */
function setupFlags(c: Command): Command {
  return c
    .option('--dry-run', '書かずに、書く先と差分だけを出す')
    .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）。書くときは --yes が要る')
    .option('--expect <fingerprint>', '見立ての指紋。見せた後に書く先が変わっていたら書かない（殻の命令が使う）');
}

const shell = program.command('shell').description('外のターミナル（VS Code など）で起動した claude を hangar で開けるようにする');

setupFlags(shell
  .command('install')
  .description('~/.zshrc に 1 行を足し、claude を hangar の tmux の中で起こしてつなぐ形に包む（承諾を求め、控えを取る）')
  .option('--yes', '問わずに足す'))
  .action(async (o: SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('shell-install', 4177, o); return; }
    const r = await runShellInstall({ tmuxPath: tmuxPathFor(hangarHome()), yes: o.yes ?? false });
    if (!r.installed) process.exitCode = 1;
  });

setupFlags(shell
  .command('uninstall')
  .description('~/.zshrc から hangar の足した行を外す（控えを取る）')
  .option('--yes', '問わずに外す（--json のとき）'))
  .action(async (o: SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('shell-uninstall', 4177, o); return; }
    runShellUninstall();
  });

shell
  .command('status')
  .description('この PC に入っているかを表示する')
  .action(() => { console.log(shellStatusLine({ tmuxPath: tmuxPathFor(hangarHome()) })); });

const config = program.command('config').description('Claude Code の設定の同期（他の PC から届いた設定を適用する、控えの世代へ戻す）');

config
  .command('apply')
  .description('適用の指示書を読み、件数と種類を見せて承諾を得てから、控えを取って ~/.claude に書く（書いたら指示書を消す）')
  .option('--yes', '問わずに書く')
  .option('--plan', '書かずに、何をどれだけ書くかだけを出す')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）')
  .option('--order <createdAt>', '確認した指示書の作成時刻。違う指示書に替わっていたら書かない（殻の命令が使う）')
  .option('--dry-run', '--plan と同じ（書かずに、書く先と差分だけを出す）')
  .option('--expect <fingerprint>', '見立ての指紋。見せた後に書く先が変わっていたら書かない（殻の命令が使う）')
  .action(async (o: { yes?: boolean; plan?: boolean; dryRun?: boolean; json?: boolean; order?: string; expect?: string }) => {
    const order = o.order === undefined ? undefined : Number(o.order);
    if (order !== undefined && !Number.isFinite(order)) throw new Error('--order には指示書の作成時刻（数）を渡してください');
    process.exitCode = await runConfigApply({ yes: o.yes, plan: o.plan || o.dryRun, json: o.json, order, expect: o.expect });
  });

config
  .command('restore [generation]')
  .description('控えの世代へ戻す。世代を省くと一覧を出す。戻す前の状態も新しい世代に控える')
  .option('--yes', '問わずに戻す')
  .option('--plan', '戻さずに、戻す先と消す先だけを出す')
  .option('--json', '結果を JSON で 1 行出す（殻の命令が読む）')
  .option('--dry-run', '--plan と同じ（戻さずに、書く先と差分だけを出す）')
  .option('--expect <fingerprint>', '見立ての指紋。見せた後に書く先が変わっていたら戻さない（殻の命令が使う）')
  .action(async (generation: string | undefined, o: { yes?: boolean; plan?: boolean; dryRun?: boolean; json?: boolean; expect?: string }) => {
    process.exitCode = await runConfigRestore({ name: generation, yes: o.yes, plan: o.plan || o.dryRun, json: o.json, expect: o.expect });
  });

const statusline = program.command('statusline').description('statusline スクリプトへの追記');

setupFlags(statusline
  .command('install')
  .description('使用量をサーバへ渡すスニペットを statusline スクリプトに追記する（承諾を求め、バックアップを取る）')
  .option('--port <n>', 'ポート', '4177')
  .option('--yes', '問わずに追記する'))
  .action(async (o: { port: string } & SetupCommandFlags) => {
    if (o.dryRun || o.json || o.expect) { process.exitCode = await setupCommand('statusline-install', Number(o.port), o); return; }
    const claudeDir = loadSettings(hangarHome()).claudeDir || defaultClaudeDir();
    const r = await runStatuslineInstall({ claudeDir, port: Number(o.port), yes: o.yes ?? false });
    if (!r.installed) process.exitCode = 1;
  });

setupFlags(statusline
  .command('uninstall')
  .description('statusline スクリプトから hangar の足した行を外す（承諾を求め、バックアップを取る）')
  .option('--yes', '問わずに外す'))
  .action(async (o: SetupCommandFlags) => {
    process.exitCode = await setupCommand('statusline-uninstall', 4177, o);
  });

// どのコマンドの失敗でも、端末には 1 行だけ出す。生のスタックは読み手の役に立たない。
// ただし wrangler の失敗のように理由が後ろの行にあるもの（DetailedError）は、整えた複数行をそのまま出す。
program.parseAsync(process.argv).catch((e) => {
  console.error(cliErrorText(e));
  process.exit(1);
});
