import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { hangarHome, startServer } from '@agent-hangar/server';
import { formatSetupReport, runSetup } from './setup.ts';

const program = new Command().name('hangar').description('agent-hangar のコマンド');

program
  .command('setup')
  .description('データディレクトリを用意し、ツールとワークスペースを確認する')
  .option('--workspace <dir>', 'ワークスペースのルート')
  .action((o: { workspace?: string }) => {
    console.log(formatSetupReport(runSetup({ home: hangarHome(), workspaceRoot: o.workspace })));
  });

program
  .command('start')
  .description('サーバを起動する')
  .option('--port <n>', 'ポート', '4177')
  .action(async (o: { port: string }) => {
    const s = await startServer({ port: Number(o.port) });
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
  .command('open')
  .description('ブラウザで UI を開く')
  .option('--port <n>', 'ポート', '4177')
  .action((o: { port: string }) => {
    spawn('open', [`http://127.0.0.1:${o.port}/`], { stdio: 'ignore', detached: true }).unref();
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
