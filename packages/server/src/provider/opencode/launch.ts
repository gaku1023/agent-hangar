import type { InjectionEntry, LaunchPlan, LaunchSpec, MaterializeMode } from '../../agent/types.ts';
import { OpencodeClient, type OpencodeModelRef } from './client.ts';
import type { ServeConfig } from './serve/env.ts';
import type { ServeInfo } from './serve/manager.ts';

/**
 * opencode の会話を hangar から起こす面（docs/design.md「opencode の起動」）。
 * hangar の会話 1 つに serve を 1 本起こし（serve/manager.ts）、API で会話を作ってから、TUI を tmux の中でその serve につなぐ。
 */

/** hangar の MCP の名前。opencode の設定の `mcp.servers` の鍵で、モデルは Code Mode の中から `tools.hangar.…` で呼ぶ。 */
export const HANGAR_MCP_NAME = 'hangar';
/** 追記を差し込む鍵。opencode は `<context key="hangar">…</context>` の形で system prompt の末尾近くに入れる。 */
export const HANGAR_INSTRUCTION_KEY = 'hangar';

/** serve の管理のうち、起動の面が使う口（serve/manager.ts の ServeManager）。鍵は hangar の会話の ID である。 */
export type OpencodeServes = {
  ensure(sessionId: string, config?: ServeConfig): Promise<ServeInfo>;
  get(sessionId: string): ServeInfo | null;
  stop(sessionId: string): Promise<void>;
};

/**
 * serve にだけ足す設定。hangar の MCP を remote で、この run の秘密を Authorization の header で渡す。
 * 利用者の opencode.json は書き換えない（opencode はこれを利用者の設定に重ねて読む）。
 */
export function hangarMcpConfig(mcp: { url: string; secret: string }): string {
  return JSON.stringify({ mcp: { servers: { [HANGAR_MCP_NAME]: { type: 'remote', url: mcp.url, headers: { Authorization: `Bearer ${mcp.secret}` } } } } });
}

/** `provider/model` の形のモデルの指定を、最初の / で割る。割れないものは渡さない（opencode の既定のモデルで始まる）。 */
export function modelRefOf(model: string | undefined): OpencodeModelRef | undefined {
  const i = model?.indexOf('/') ?? -1;
  if (!model || i <= 0 || i === model.length - 1) return undefined;
  return { providerID: model.slice(0, i), id: model.slice(i + 1) };
}

/** 段を区切りを足さずにつないだ 1 つの追記。段が無ければ null（PUT しない）。 */
export function instructionValue(entries: readonly InjectionEntry[]): string | null {
  return entries.length ? entries.map((e) => e.text).join('') : null;
}

/**
 * tmux の中で起こす TUI。返った ID の会話を、その会話の serve につなぐ。
 * パスワードは環境（`OPENCODE_PASSWORD`）で渡し、argv に載せない（URL に入れても通るが、argv は `ps` で誰からも読める）。
 * tmux の `-e` で渡すと tmux クライアントの argv とセッションの環境に残るので、秘密の環境（`secretEnv`）として 0600 のファイルから包みに読ませる。
 * `--auto` は自動承認がオンのときだけ、初期プロンプトは `--prompt` で渡す（2.1.4 では `-s` の会話にそのまま送られる）。
 * Claude だけの指定（effort、追加ディレクトリ、worktree、Remote Control）は捨てる。RunManager が入口で断る。
 * 起こすものへは CLAUDE 系と HANGAR_* を持ち込まない。アカウントの置き場（CLAUDE_CONFIG_DIR）も opencode には効かせない（決定 9）。
 */
export function planOpencode(bin: string, providerSessionId: string, spec: LaunchSpec, serve: Pick<ServeInfo, 'url' | 'password'>, droppedEnv: readonly string[]): LaunchPlan {
  const argv = [bin, spec.cwd, '--server', serve.url, '-s', providerSessionId];
  if (spec.autoApprove) argv.push('--auto');
  if (spec.prompt) argv.push('--prompt', spec.prompt);
  return { argv, env: {}, secretEnv: { OPENCODE_PASSWORD: serve.password }, unset: [...new Set([...droppedEnv, 'CLAUDE_CONFIG_DIR'])] };
}

export type MaterializeDeps = {
  serves: OpencodeServes;
  /** 知らせ。指示を差し込めなかった（instructions）、MCP がつながらなかった（mcp）。どちらも起動は止めない。 */
  report: (what: 'instructions' | 'mcp', e: unknown) => void;
  /** MCP の接続を待つ上限と間隔。 */
  mcpWaitMs?: number;
  mcpPollMs?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 新しい会話を起こす前の下ごしらえ。返すのは opencode が振った会話の ID である。
 * 1. serve を起こす（hangar の MCP の設定を足して）。
 * 2. ID を付けずに `POST /api/session` で会話を作る。hangar が決めた ID の会話は、OpenCode Zen の無料枠のモデルが FreeTierError（403）で断るからである。
 * 3. 追記を `PUT …/instructions/entries/hangar` で差し込む。API が無い版でも起動は続け、知らせだけ出す。
 * 4. hangar の MCP が connected になるのを待つ。待たずに最初のプロンプトを送ると、1 歩目の Code Mode の目録に hangar の道具が載らない。
 *    上限を過ぎても、failed でも、起動は続ける（2 歩目から呼べるようになる）。
 * 会話を作れなければ、起こした serve を止めて投げる。
 * 再開とフォークは段 B6 で入れるので、いまは受けない。
 */
export async function materializeOpencode(deps: MaterializeDeps, mode: MaterializeMode, spec: LaunchSpec): Promise<{ providerSessionId: string; serve: ServeInfo }> {
  if (mode.kind !== 'start') throw new Error(`opencode cannot ${mode.kind} a session yet`);
  const serve = await deps.serves.ensure(spec.hangarSessionId, { configContent: hangarMcpConfig(spec.mcp) });
  const client = new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs });
  let providerSessionId: string;
  try {
    providerSessionId = await client.createSession({ directory: spec.cwd, title: spec.name, agent: spec.mode, model: modelRefOf(spec.model) });
  } catch (e) {
    await deps.serves.stop(spec.hangarSessionId).catch(() => undefined);
    throw e;
  }
  await putInstructions(client, providerSessionId, spec.instructions, deps.report);
  await waitForMcp(client, spec.cwd, deps);
  return { providerSessionId, serve };
}

/** 追記を差し込む。段が無ければ何もしない。失敗は知らせるだけで投げない。 */
export async function putInstructions(client: OpencodeClient, providerSessionId: string, entries: readonly InjectionEntry[], report: MaterializeDeps['report']): Promise<void> {
  const value = instructionValue(entries);
  if (value === null) return;
  try {
    await client.putInstruction(providerSessionId, HANGAR_INSTRUCTION_KEY, value);
  } catch (e) {
    report('instructions', e);
  }
}

/** hangar の MCP が connected になるまで待つ。failed なら待つのをやめ、上限を過ぎてもやめる。どちらも知らせるだけで投げない。 */
async function waitForMcp(client: OpencodeClient, directory: string, deps: MaterializeDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const deadline = Date.now() + (deps.mcpWaitMs ?? 15_000);
  let last = 'unknown';
  for (;;) {
    try {
      last = (await client.mcpStatus(directory)).find((x) => x.name === HANGAR_MCP_NAME)?.status ?? 'missing';
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (last === 'connected') return;
    if (last === 'failed') break;
    if (Date.now() >= deadline) break;
    await sleep(deps.mcpPollMs ?? 250);
  }
  deps.report('mcp', new Error(`the hangar MCP server is not connected (${last})`));
}
