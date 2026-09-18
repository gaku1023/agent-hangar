import { Command } from 'commander';
import { claudeJsonPath, defaultClaudeDir, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, startServer } from '@agent-hangar/server';
import { runSetupCloud } from './cloud.ts';
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
  .command('start')
  .description('サーバを起動する')
  .option('--port <n>', 'ポート', '4177')
  .option('--no-open', 'ブラウザを開かない')
  .action(async (o: { port: string; open: boolean }) => {
    let s: Awaited<ReturnType<typeof startServer>>;
    try {
      s = await startServer({ port: Number(o.port) });
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
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // 接続の後始末が終わらなくても 3 秒で終了する。
      setTimeout(() => process.exit(0), 3000).unref();
      s.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
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
