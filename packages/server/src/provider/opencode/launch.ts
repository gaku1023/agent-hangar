import type { LaunchPrepChoice } from '@agent-hangar/shared';
import type { InjectionEntry, LaunchPlan, LaunchSpec, MaterializeMode } from '../../agent/types.ts';
import type { LaunchPrep } from '../../runs/launchPrep.ts';
import { OpencodeClient, type OpencodeModelRef } from './client.ts';
import type { OpencodePermissionRule } from './permissionPreset.ts';
import type { ServeEnsureOptions, ServeInfo } from './serve/manager.ts';
import { prepareLocalModels, type LocalModelsDeps, type LocalModelUse } from './localModels/prepare.ts';
import type { ProviderPreps } from './providerPrep.ts';

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
  ensure(sessionId: string, config?: ServeEnsureOptions): Promise<ServeInfo>;
  get(sessionId: string): ServeInfo | null;
  stop(sessionId: string): Promise<void>;
};

/**
 * serve にだけ足す設定。hangar の MCP を remote で、この run の秘密を Authorization の header で渡す。
 * permissions は許可のひな形（permissionPreset.ts）で、渡されたときだけ 2.x の `permissions` に並びのまま入れる。
 * extra は起動前の準備が重ねる設定（1 モデルに寄せるときの agent と small_model の上書き）。
 * 利用者の opencode.json は書き換えない（opencode はこれを利用者の設定に重ねて読む）。
 */
export function hangarServeConfig(mcp: { url: string; secret: string }, permissions: readonly OpencodePermissionRule[] | null = null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    mcp: { servers: { [HANGAR_MCP_NAME]: { type: 'remote', url: mcp.url, headers: { Authorization: `Bearer ${mcp.secret}` } } } },
    ...(permissions ? { permissions } : {}),
  });
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
  /** 会話のフォルダで重ねる許可のひな形（permissionPreset.ts の permissionPresetFor）。null か省けば重ねない。 */
  permissions?: (cwd: string) => readonly OpencodePermissionRule[] | null;
  /** 知らせ。指示を差し込めなかった（instructions）、MCP がつながらなかった（mcp）。どちらも起動は止めない。 */
  report: (what: 'instructions' | 'mcp', e: unknown) => void;
  /** MCP の接続を待つ上限と間隔。 */
  mcpWaitMs?: number;
  mcpPollMs?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 起動前にローカルのモデルを整える口（localModels/prepare.ts）。無ければ整えない。 */
  localModels?: LocalModelsDeps;
  /** 起動前に接続先の準備のコマンドを走らせる口（providerPrep.ts）。無ければ走らせない。 */
  providerPreps?: ProviderPreps;
};

/**
 * 新しい会話を起こす前の下ごしらえ。返すのは opencode が振った会話の ID である。
 * 1. serve を会話のフォルダで起こす（hangar の MCP の設定と、許可のひな形を足して）。
 * 2. ID を付けずに `POST /api/session` で会話を作る。hangar が決めた ID の会話は、OpenCode Zen の無料枠のモデルが FreeTierError（403）で断るからである。
 * 3. 追記を `PUT …/instructions/entries/hangar` で差し込む。API が無い版でも起動は続け、知らせだけ出す。
 * 4. hangar の MCP が connected になるのを待つ。待たずに最初のプロンプトを送ると、1 歩目の Code Mode の目録に hangar の道具が載らない。
 *    上限を過ぎても、failed でも、起動は続ける（2 歩目から呼べるようになる）。
 * 会話を作れなければ、起こした serve を止めて投げる。
 *
 * 再開（resume）は、終わった画面の「再開」から来る。既にある会話（mode.id）に、新しい serve でつなぎ直す。
 * serve が残っていれば先に止める。起きている serve には新しい run の MCP の秘密を当て直せない（ensure の config は起こすときにだけ効く）からである。
 * 会話は作らず、追記を PUT し直し（serve を起こし直すと追記は消える）、MCP を待つ。
 * フォークは受けない（caps.fork が偽で、RunManager が入口で断る）。
 */
export async function materializeOpencode(deps: MaterializeDeps, mode: MaterializeMode, spec: LaunchSpec): Promise<{ providerSessionId: string; serve: ServeInfo }> {
  if (mode.kind !== 'start' && mode.kind !== 'resume') throw new Error(`opencode cannot ${mode.kind} a session`);
  if (mode.kind === 'resume') await deps.serves.stop(spec.hangarSessionId);
  let serve = await deps.serves.ensure(spec.hangarSessionId, { configContent: hangarServeConfig(spec.mcp, deps.permissions?.(spec.cwd) ?? null), directory: spec.cwd });
  let model = spec.model;
  let providerSessionId: string;
  try {
    if (spec.prep && deps.providerPreps?.any() && !spec.prep.choice.skip) await prepareProviders(deps, deps.providerPreps, serve, spec);
    if (spec.prep && deps.localModels && !spec.prep.choice.skip) ({ serve, model } = await prepareModels(deps, deps.localModels, serve, spec));
    if (mode.kind === 'resume') {
      providerSessionId = mode.id;
    } else {
      providerSessionId = await new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs }).createSession({ directory: spec.cwd, title: spec.name, agent: spec.mode, model: modelRefOf(model) });
    }
  } catch (e) {
    await deps.serves.stop(spec.hangarSessionId).catch(() => undefined);
    throw e;
  }
  const client = new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs });
  await putInstructions(client, providerSessionId, spec.instructions, deps.report);
  await waitForMcp(client, spec.cwd, deps);
  return { providerSessionId, serve };
}

/**
 * 起動前に、会話と agent が使う接続先の準備のコマンドを走らせる（docs/design.md「接続先の準備」）。LM Studio のモデルを整えるより先に走らせる。
 * 使う接続先は起きた serve の設定の層から読む。答えが「1 モデルに寄せる」なら、そのモデルの接続先だけを使う。
 * 準備のある接続先が無ければ何もしない。失敗は ProviderPrepFailed で投げる（起動の口が serve を止めて断る）。
 */
export async function prepareProviders(deps: MaterializeDeps, preps: ProviderPreps, serve: ServeInfo, spec: LaunchSpec): Promise<void> {
  const prep = spec.prep!;
  const client = new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs });
  const conf = prep.choice.singleModel ? null : await client.modelUses(spec.cwd);
  const refs = conf ? usesOf(conf, spec.model ?? conf.model ?? undefined).map((u) => u.ref) : [prep.choice.singleModel!];
  const ids = preps.configured(refs.flatMap((r) => (r.indexOf('/') > 0 ? [r.slice(0, r.indexOf('/'))] : [])));
  if (!ids.length) return;
  prep.run.throwIfCancelled();
  const names = new Map((await client.providerRows(spec.cwd).catch(() => [])).map((r) => [r.id, r.name]));
  for (const id of ids) await preps.prepare(id, names.get(id) ?? id, spec.hangarSessionId, prep.run);
}

/**
 * 起動前に、会話と agent が使うローカルのモデルを整える（docs/design.md「起動前の準備」）。
 * 使うモデルは起きた serve の設定の層から読む（場所の opencode.json も重なるので、hangar が自分で読むより確か）。
 * 答えが「1 モデルに寄せる」（choice.singleModel）なら、agent と small_model のモデルをそのモデルに上書きする設定で serve を起こし直し、会話もそのモデルで作る。
 * 返すのは、使う serve（起こし直したらその serve）と会話のモデル。
 */
export async function prepareModels(deps: MaterializeDeps, local: LocalModelsDeps, serve: ServeInfo, spec: LaunchSpec): Promise<{ serve: ServeInfo; model: string | undefined }> {
  const prep = spec.prep!;
  const client = new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs });
  const conf = await client.modelUses(spec.cwd);
  prep.run.throwIfCancelled();
  const single = prep.choice.singleModel;
  if (!single) {
    const model = spec.model ?? conf.model ?? undefined;
    await prepareWith(local, client, { hangarSessionId: spec.hangarSessionId, cwd: spec.cwd, uses: usesOf(conf, model), prep: prep.run, choice: prep.choice });
    return { serve, model };
  }
  const agent = Object.fromEntries(conf.agents.filter((a) => a.model !== single).map((a) => [a.id, { model: single }]));
  const override: Record<string, unknown> = { ...(Object.keys(agent).length ? { agent } : {}), ...(conf.small && conf.small !== single ? { small_model: single } : {}) };
  if (Object.keys(override).length) {
    await deps.serves.stop(spec.hangarSessionId);
    serve = await deps.serves.ensure(spec.hangarSessionId, { configContent: hangarServeConfig(spec.mcp, deps.permissions?.(spec.cwd) ?? null, override), directory: spec.cwd });
  }
  const uses = [{ ref: single, uses: ['$session', ...(conf.small ? ['$small'] : []), ...conf.agents.map((a) => a.id)] }];
  await prepareWith(local, new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs }), { hangarSessionId: spec.hangarSessionId, cwd: spec.cwd, uses, prep: prep.run, choice: prep.choice });
  return { serve, model: single };
}

/**
 * 動いている会話のモデルを整え直す（起動後に長さが足りずに落ちた札の「整えて再開」）。serve は起こし直さない。
 * 利用者が頼んだので、使うモデルが短く載っていれば、手で載せたものでも載せ直す（reloadShort）。ほかのモデルは外さない。
 * model は会話のモデル（分からなければ設定の既定）。
 */
export async function prepareRunning(local: LocalModelsDeps, serve: ServeInfo, o: { hangarSessionId: string; cwd: string; model: string | null; prep: LaunchPrep; requestTimeoutMs?: number }): Promise<void> {
  const client = new OpencodeClient(serve, { timeoutMs: o.requestTimeoutMs });
  const conf = await client.modelUses(o.cwd);
  await prepareWith(local, client, { hangarSessionId: o.hangarSessionId, cwd: o.cwd, uses: usesOf(conf, o.model ?? conf.model ?? undefined), prep: o.prep, choice: {}, reloadShort: true });
}

/** 会話のモデル、small_model、agent ごとのモデルを、モデルごとの使い手にまとめる。 */
function usesOf(conf: { small: string | null; agents: { id: string; model: string }[] }, model: string | undefined): LocalModelUse[] {
  const byRef = new Map<string, string[]>();
  const add = (ref: string | null | undefined, use: string) => { if (ref) byRef.set(ref, [...(byRef.get(ref) ?? []), use]); };
  add(model, '$session');
  add(conf.small, '$small');
  for (const a of conf.agents) add(a.model, a.id);
  return [...byRef].map(([ref, u]) => ({ ref, uses: u }));
}

async function prepareWith(local: LocalModelsDeps, client: OpencodeClient, o: { hangarSessionId: string; cwd: string; uses: LocalModelUse[]; prep: LaunchPrep; choice: LaunchPrepChoice; reloadShort?: boolean }): Promise<void> {
  const [providers, models] = await Promise.all([client.providerRows(o.cwd), client.models(o.cwd)]);
  o.prep.throwIfCancelled();
  const limits = new Map(models.flatMap((m) => (m.context ? [[`${m.providerID}/${m.id}`, m.context] as const] : [])));
  await prepareLocalModels(local, { hangarSessionId: o.hangarSessionId, uses: o.uses, providers: providers.map((p) => ({ id: p.id, baseURL: p.baseURL })), limits, choice: o.choice, prep: o.prep, reloadShort: o.reloadShort });
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
