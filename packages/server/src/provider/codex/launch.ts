import { codexBaseEnv } from './env.ts';
import { CodexRpc, startAppServer, stopAppServer, tuiRemote, type AppServerProcess, type StartAppServerOptions } from './appServer.ts';
import { LaunchQueue } from '../opencode/serve/queue.ts';

/**
 * app-server の起動の待ち行列と、起動から接続までの手順（計画の B2）。
 * Codex の AgentLauncher（materialize、plan、reattach、release）は B3 で、ここには無い。
 *
 * 起動は opencode の serve と同じく 1 本ずつ並べる。1 つの仕事は「起こして、/healthz が 200 を返し、initialize が通る」までで、それが済むまで次を始めない。
 */
export const codexLaunchQueue = new LaunchQueue();

export type CodexAppServerHandle = {
  server: AppServerProcess;
  rpc: CodexRpc;
  /** TUI を `--remote` でつなぐための argv の追加分と環境変数（token はこの env にだけある）。 */
  tuiRemote: { args: string[]; env: Record<string, string> };
  /** 接続を閉じ、app-server を止める（TUI は呼び手が先に閉じておく）。 */
  stop: (o?: { graceMs?: number }) => Promise<void>;
};

export type LaunchCodexAppServerOptions = Omit<StartAppServerOptions, 'env'> & {
  env?: NodeJS.ProcessEnv;
  queue?: LaunchQueue;
};

/** app-server を（待ち行列に並んで）起こし、つないで initialize まで済ませる。つなげなければ起こしたものを止めて投げる。 */
export function launchCodexAppServer(o: LaunchCodexAppServerOptions): Promise<CodexAppServerHandle> {
  const queue = o.queue ?? codexLaunchQueue;
  return queue.run(async () => {
    const server = await startAppServer({ ...o, env: o.env ?? codexBaseEnv(o.bin) });
    let rpc: CodexRpc;
    try {
      rpc = await CodexRpc.connect({ url: server.url, token: server.token });
    } catch (e) {
      await stopAppServer(server);
      throw e;
    }
    return {
      server,
      rpc,
      tuiRemote: tuiRemote(server.url, server.token),
      stop: async (so) => {
        rpc.close();
        await stopAppServer(server, so);
      },
    };
  });
}
