import { Command } from 'commander';
import { claudeJsonPath, defaultClaudeDir, hangarHome, installShutdown, loadSettings, readOrCreateDevice, readOrCreateToken, startServer } from '@agent-hangar/server';
import { cloudStatus, promptWord, readJoinToken, runJoin, runSetupCloud, runTeardown } from './cloud.ts';
import { runMcpInstall, runMcpUninstall } from './mcp.ts';
import { oneLineError, probeHealth, serverDownMessage, startErrorMessage } from './probe.ts';
import { formatSetupReport, runSetup } from './setup.ts';
import { runStatuslineInstall } from './statusline.ts';
import { entryUrl, openInBrowser } from './url.ts';

const program = new Command().name('hangar').description('agent-hangar のコマンド');

// setup はサブコマンド（setup cloud）の親でもある。
// commander では親に action を残したまま子を足せるので、既定の動作はこの action のままである。
const setup = program
  .command('setup')
  .description('データディレクトリを用意し、ツールとワークスペースを確認し、statusline への追記を提案する')
  .option('--workspace <dir>', 'ワークスペースのルート')
  .option('--yes', '問いかけをすべて承諾する')
  .option('--skip-statusline', 'statusline への追記を提案しない')
  .action(async (o: { workspace?: string; yes?: boolean; skipStatusline?: boolean }) => {
    const home = hangarHome();
    const r = runSetup({ home, workspaceRoot: o.workspace });
    console.log(formatSetupReport(r));
    if (!o.skipStatusline && !r.statusline.installed) {
      console.log('');
      const claudeDir = loadSettings(home).claudeDir || defaultClaudeDir();
      await runStatuslineInstall({ claudeDir, port: 4177, yes: o.yes ?? false });
    }
    console.log('');
    console.log('MCP の登録は hangar mcp install で行えます。');
  });

setup
  .command('cloud')
  .description('自分の Cloudflare アカウントに同期用の Worker と D1 と R2 を作ってデプロイする')
  .option('--name <name>', 'Worker の名前（D1 は同名、R2 は <name>-files）', 'hangar')
  .option('--rotate-secret', '参加用の秘密を作り直す（既存の暗号化ファイルが復号できなくなる。確認を求める）')
  .action(async (o: { name: string; rotateSecret?: boolean }) => {
    const home = hangarHome();
    const device = readOrCreateDevice(home);
    await runSetupCloud({ home, device, name: o.name, rotateSecret: o.rotateSecret });
  });

program
  .command('join [token]')
  .description('参加トークンでクラウド同期に参加する（トークンは引数を省くと標準入力から受け取る）')
  .option('--force', '確認を省いて参加する（既存の cloud.json も上書きする）')
  .action(async (token: string | undefined, o: { force?: boolean }) => {
    // 秘密は argv に載せない。引数で渡されたときは、残ることを伝える。
    if (token !== undefined) {
      console.log('注意: 参加トークンを引数で渡しました。ps とシェルの履歴に残ります。次からは引数なしの hangar join を使ってください。');
    }
    // 確認は標準入力で取る。トークンを流し込んだ後の標準入力ではもう聞けないので、先に断る。
    if (!process.stdin.isTTY && !o.force) {
      throw new Error('標準入力が対話ではないので確認を取れません。端末から実行するか、--force を付けてください');
    }
    const home = hangarHome();
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
    let s: Awaited<ReturnType<typeof startServer>>;
    const startup = startServer({ port: Number(o.port) });
    // 受け口は解決を待たずに立てる。理由は packages/server/src/main.ts と同じである。
    installShutdown(startup);
    try {
      s = await startup;
    } catch (e) {
      // 生のスタックを 11 行出しても、次に何をすればよいかは分からない。
      console.error(startErrorMessage(e, Number(o.port)));
      process.exit(1);
    }
    // 鍵は端末にだけ印字する。サーバのログには載せない。見直したくなったら hangar url で出せる。
    const url = entryUrl(s.port, readOrCreateToken(hangarHome()));
    console.log('');
    console.log(`この URL から開いてください: ${url}`);
    console.log('鍵はページを開いた時点でクッキーに変わり、URL からは消えます。以後はブックマークから開けます。');
    console.log('この URL を出し直すには hangar url を実行してください。');
    if (o.open) openInBrowser(url);
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
    // 印字もする。別のブラウザで開きたいときの手掛かりになり、401 の案内ともかみ合う。
    // 鍵は argv に載せない。openInBrowser が標準入力から渡す。
    const url = entryUrl(port, readOrCreateToken(hangarHome()));
    console.log(url);
    openInBrowser(url);
  });

const mcp = program.command('mcp').description('Claude Code への MCP 登録');

mcp
  .command('install')
  .description('user スコープに hangar を登録する')
  .option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => {
    const r = await runMcpInstall({ home: hangarHome(), port: Number(o.port), claudeJson: claudeJsonPath() });
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
  });

mcp
  .command('uninstall')
  .description('user スコープの hangar を削除する')
  .action(async () => {
    const r = await runMcpUninstall();
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
  });

const statusline = program.command('statusline').description('statusline スクリプトへの追記');

statusline
  .command('install')
  .description('使用量をサーバへ渡すスニペットを statusline スクリプトに追記する（承諾を求め、バックアップを取る）')
  .option('--port <n>', 'ポート', '4177')
  .option('--yes', '問わずに追記する')
  .action(async (o: { port: string; yes?: boolean }) => {
    const claudeDir = loadSettings(hangarHome()).claudeDir || defaultClaudeDir();
    const r = await runStatuslineInstall({ claudeDir, port: Number(o.port), yes: o.yes ?? false });
    if (!r.installed) process.exitCode = 1;
  });

// どのコマンドの失敗でも、端末には 1 行だけ出す。生のスタックは読み手の役に立たない。
program.parseAsync(process.argv).catch((e) => {
  console.error(oneLineError(e));
  process.exit(1);
});
