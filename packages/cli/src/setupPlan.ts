import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diffLines, ensureHome, ensureShellScript, installShellHook, planShellHook, planShellUnhook, planStatuslineRemoval, planStatuslineSnippet,
  readOrCreateToken, readUserMcpServers, readUtf8Text, removeStatuslineSnippet, appendStatuslineSnippet, resolveStatuslineScript, SHELL_MARKER,
  shellHookLine, shellScriptPath, shellWrapOsSupported, shellWrapSupported, statuslineHeaderPath, statuslineSnippetFor, uninstallShellHook,
  writeStatuslineHeaderFile,
} from '@agent-hangar/server/src/cliEntry.ts';
import { execCli, runMcpInstall, runMcpUninstall, type CliExec, type PortProbe } from './mcp.ts';

/**
 * 連携の書き込み（MCP の登録、シェル連携、ステータスライン）の見立てと、見立てどおりの書き込み。
 *
 * 殻の承諾の窓（apps/desktop の approve）は、`hangar <対象> --dry-run --json` でこの見立てを受け取り、
 * 書く先のファイル、新規か変更か削除か、差分を利用者に見せる。
 * 承諾されたら `--yes --json --expect <指紋>` を走らせる。
 * 書く直前にもう一度見立てを作り、指紋が見せたときと違えば、何も書かずに changed で断る（全体計画の D9）。
 * サーバはここを通らない。利用者のファイルを書くのは、この CLI と殻の命令だけである。
 *
 * 見立ては、書く処理と同じ「次の中身を決める関数」（planShellHook、planStatuslineSnippet など）から作る。
 * 見せた差分と、実際に書く中身が食い違わないようにするためである。
 */

// 対象の並びは shared にある（画面のボタンと殻の命令も同じものを使う）。
export { SETUP_TARGETS, isSetupTarget, type SetupTarget } from '@agent-hangar/shared';
import type { SetupTarget } from '@agent-hangar/shared';

/** 伏せた値の置き場。承諾の窓は、この文字を黒い帯にして出す。トークンそのものは見立てに載せない。 */
export const SECRET_MASK = '\u0000';

/** 差分の 1 行。add は足す、del は消す、ctx は前後の文脈、gap は省いた行の印。 */
export type PlanLine = { k: 'add' | 'del' | 'ctx' | 'gap'; t: string };

/**
 * 書く先の 1 つ。
 * op は、create（無いので作る）、modify（足すか差し替える）、remove（消す）、own（hangar 自身の置き場。利用者のファイルではない）。
 * what は承諾の窓が文を選ぶ鍵で、n はその文に入れる数（足す行の数など）。
 * where は差分がファイルのどこか（head は先頭、tail は末尾、json は mcpServers の中）。
 * watch は見せた部分の指紋で、書く直前に比べる。own は比べない。
 */
export type PlanFile = { path: string; op: 'create' | 'modify' | 'remove' | 'own'; what: string; n?: number; where: 'head' | 'tail' | 'json' | null; lines: PlanLine[]; watch: string | null };

/**
 * 見立て。state は、ready（書ける）、noop（もう済んでいる）、blocked（この PC では書けない）。
 * reason は noop と blocked の理由で、code は承諾の窓や画面が文を選ぶ鍵、message は端末に出す日本語の 1 文である。
 * backup は、書く前に取るバックアップの置き場（もとのファイルが無ければ null）。secret は、差分に伏せた値があるか。
 * backup の名前の末尾の日時は、書いたときに決まる。見立てでは BACKUP_STAMP（YYYYMMDDhhmmss）の形のまま見せる。
 * 見立てを作った時刻で名前を決めると、承諾の窓を開いた時刻の名前を見せて、押した時刻の名前で書くことになり、食い違う。
 */
export type SetupPlan = {
  target: SetupTarget;
  state: 'ready' | 'noop' | 'blocked';
  reason: { code: string; message: string } | null;
  files: PlanFile[];
  backup: string | null;
  secret: boolean;
  fingerprint: string;
};

/** 見立てと書き込みに要る、この PC の値。試験は一時ディレクトリを渡す。 */
export type SetupEnv = {
  home: string;
  claudeDir: string;
  claudeJson: string;
  zshrc: string;
  port: number;
  tmuxPath: string | null;
  loginShell: string;
  platform: NodeJS.Platform;
  homeDir: string;
  exec?: CliExec;
  probe?: PortProbe;
  now?: () => Date;
  /** 書く直前の確かめの後、ロックを取る前に呼ぶ。試験が割り込みの書き込みを差すための穴である。 */
  beforeLock?: () => void;
};

/** 差分に出す行の上限。超えた分は gap の 1 行にする。 */
const MAX_LINES = 120;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** 見立てで見せるバックアップの名前の、日時の置き場。書いたときに、その時刻の 14 桁（年月日時分秒）になる。 */
export const BACKUP_STAMP = 'YYYYMMDDhhmmss';

function cap(lines: PlanLine[]): PlanLine[] {
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES), { k: 'gap', t: String(lines.length - MAX_LINES) }];
}

const textDiff = (before: string, after: string): PlanLine[] =>
  cap(diffLines(before, after).map((l) => ({ k: l.kind, t: l.text })));

function fingerprintOf(target: SetupTarget, files: PlanFile[]): string {
  return sha(JSON.stringify([target, files.filter((f) => f.op !== 'own').map((f) => [f.path, f.watch])]));
}

function plan(target: SetupTarget, p: Omit<SetupPlan, 'target' | 'fingerprint' | 'secret'> & { secret?: boolean }): SetupPlan {
  return { target, secret: p.secret ?? false, ...p, fingerprint: fingerprintOf(target, p.files) };
}

const stop = (target: SetupTarget, state: 'noop' | 'blocked', code: string, message: string): SetupPlan => plan(target, { state, reason: { code, message }, files: [], backup: null });

// ---- MCP ----

/** MCP の登録の値。トークンはここでだけ扱い、見立てには伏せて載せる。 */
function mcpServer(env: SetupEnv, token: string) {
  return { type: 'http', url: `http://127.0.0.1:${env.port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}

/** headers の値を伏せる。Bearer の後ろだけを伏せ、ほかは値ごと伏せる。 */
function masked(server: unknown): unknown {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return server;
  const s = server as Record<string, unknown>;
  const h = s.headers;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return s;
  const hidden = Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('Bearer ') ? `Bearer ${SECRET_MASK}` : SECRET_MASK]));
  return { ...s, headers: hidden };
}

/** "hangar": { … } の行を、mcpServers の中の字下げ（2）で作る。最後の行の後ろの , は呼び手が決める。 */
function entryLines(name: string, value: unknown): string[] {
  // JSON.stringify は伏せ字（NUL）を \u0000 の 6 文字に逃がすので、戻す。
  const body = JSON.stringify(masked(value), null, 2).replaceAll('\\u0000', SECRET_MASK).split('\n');
  return [`  ${JSON.stringify(name)}: ${body[0]}`, ...body.slice(1).map((l) => `  ${l}`)];
}

/**
 * mcpServers の差分。~/.claude.json は大きく、ほかのサーバの秘密も入っているので、ファイルの全体の差分にはしない。
 * mcpServers の中だけを見せ、ほかのサーバは名前だけにして中身を畳む。
 */
function mcpLines(servers: Record<string, unknown> | null, name: string, before: unknown, after: unknown): PlanLine[] {
  const out: PlanLine[] = [{ k: 'ctx', t: '"mcpServers": {' }];
  const others = Object.keys(servers ?? {}).filter((k) => k !== name);
  for (const other of others) out.push({ k: 'ctx', t: `  ${JSON.stringify(other)}: { … },` });
  // 解除で後ろに続く行が無くなるときは、最後に残るサーバの行の , も外れるので、その行も差分に出す（見せる差分と書く中身をそろえる）。
  // 最後の 1 つを消したときは、空の "mcpServers": {} が残る（removeUserMcpServer）。
  if (after === undefined && others.length > 0) {
    const last = out.pop()!;
    out.push({ k: 'del', t: last.t }, { k: 'add', t: last.t.slice(0, -1) });
  }
  if (before !== undefined) for (const t of entryLines(name, before)) out.push({ k: 'del', t });
  if (after !== undefined) for (const t of entryLines(name, after)) out.push({ k: 'add', t });
  out.push({ k: 'ctx', t: '}' });
  return out;
}

const mcpWatch = (servers: Record<string, unknown> | null) => sha(JSON.stringify(servers ?? null));

function readServers(env: SetupEnv): { ok: true; servers: Record<string, unknown> | null } | { ok: false } {
  try {
    return { ok: true, servers: readUserMcpServers(env.claudeJson) };
  } catch {
    return { ok: false };
  }
}

function planMcp(target: 'mcp-install' | 'mcp-uninstall', env: SetupEnv): SetupPlan {
  const read = readServers(env);
  if (!read.ok) return stop(target, 'blocked', 'broken-json', `${env.claudeJson} が JSON として読めないので、書き換えません。`);
  const servers = read.servers;
  const cur = servers && Object.hasOwn(servers, 'hangar') ? servers.hangar : undefined;
  const exists = fs.existsSync(env.claudeJson);
  const backup = exists ? path.join(env.home, 'backups', `claude.json-${BACKUP_STAMP}`) : null;
  if (target === 'mcp-uninstall') {
    if (cur === undefined) return stop(target, 'noop', 'absent', 'user スコープに MCP サーバ hangar は登録されていません。');
    return plan(target, { state: 'ready', reason: null, backup, secret: true, files: [{ path: env.claudeJson, op: 'remove', what: 'mcp.remove', where: 'json', lines: mcpLines(servers, 'hangar', cur, undefined), watch: mcpWatch(servers) }] });
  }
  // claude が入っていない PC に登録しても意味が無い（runMcpInstall と同じ確かめ）。
  if ((env.exec ?? execCli)('claude', ['--version']).notFound) return stop(target, 'blocked', 'no-claude', 'Claude Code が見つかりません。claude コマンドをインストールするか、PATH を通してから実行してください。');
  ensureHome(env.home);
  const want = mcpServer(env, readOrCreateToken(env.home));
  if (cur !== undefined && JSON.stringify(cur) === JSON.stringify(want)) return stop(target, 'noop', 'already', 'user スコープに MCP サーバ hangar は登録済みです。');
  return plan(target, {
    state: 'ready', reason: null, backup, secret: true,
    files: [{ path: env.claudeJson, op: exists ? 'modify' : 'create', what: cur === undefined ? 'mcp.add' : 'mcp.replace', where: 'json', lines: mcpLines(servers, 'hangar', cur, want), watch: mcpWatch(servers) }],
  });
}

// ---- シェル連携 ----

function shellBlock(env: SetupEnv): { code: string; message: string } | null {
  if (!shellWrapOsSupported(env.platform)) return { code: 'windows', message: 'Windows ではシェル連携を使えません。claude は Hangar から起動してください。' };
  if (!/(^|\/)zsh$/.test(env.loginShell)) return { code: 'not-zsh', message: `ログインシェルが zsh ではありません（${env.loginShell || '不明'}）。いまは zsh だけに対応しています。` };
  if (!shellWrapSupported(env.tmuxPath, env.platform)) return { code: 'no-tmux', message: 'この PC では tmux が見つかりません。包み方は hangar の tmux の中で claude を起こすので、tmux が要ります。' };
  return null;
}

/** UTF-8 でないファイルを断る理由。承諾の窓は開かず、画面は鍵（not-utf8）から文を引く。 */
const NOT_UTF8 = (file: string) => `${file} が UTF-8 で保存されていない（UTF-16 など）ので、書き換えません。UTF-8 で保存し直すか、手で追記してください。`;

function planShell(target: 'shell-install' | 'shell-uninstall', env: SetupEnv): SetupPlan {
  const read = readUtf8Text(env.zshrc);
  // UTF-8 で書き戻すと壊れるので、入れるのも外すのも断る（server の config/textEncoding.ts）。
  if (read !== null && 'problem' in read) return stop(target, 'blocked', 'not-utf8', NOT_UTF8(env.zshrc));
  const cur = read === null ? null : read.text;
  const backupOf = () => (cur === null ? null : `${env.zshrc}.bak-${BACKUP_STAMP}`);
  if (target === 'shell-uninstall') {
    const next = planShellUnhook(cur);
    if (next === null || cur === null) return stop(target, 'noop', 'absent', 'シェル連携は入っていません。');
    return plan(target, { state: 'ready', reason: null, backup: backupOf(), files: [{ path: env.zshrc, op: 'remove', what: 'shell.remove', where: 'tail', lines: textDiff(cur, next), watch: sha(cur) }] });
  }
  const block = shellBlock(env);
  if (block) return stop(target, 'blocked', block.code, block.message);
  const next = planShellHook(cur, shellHookLine(env.home, env.homeDir));
  if (next === null) return stop(target, 'noop', 'already', 'シェル連携は入っています。');
  const replacing = (cur ?? '').split('\n').some((l) => l.includes(SHELL_MARKER));
  return plan(target, {
    state: 'ready', reason: null, backup: backupOf(),
    files: [
      { path: env.zshrc, op: cur === null ? 'create' : 'modify', what: replacing ? 'shell.replace' : 'shell.add', where: 'tail', lines: textDiff(cur ?? '', next), watch: cur === null ? null : sha(cur) },
      { path: shellScriptPath(env.home), op: 'own', what: 'shell.script', where: null, lines: [], watch: null },
    ],
  });
}

// ---- ステータスライン ----

const STATUSLINE_REASON: Record<string, string> = {
  'no-script': 'ステータスラインのスクリプトが見つかりません。Claude Code で /statusline を実行してスクリプトを作ってから、もう一度試してください。',
  unreadable: 'スクリプトの hangar の行の範囲を読み取れません（手で書き換えられています）。何も変えません。手で入れ替えてください。',
  'ps-param': 'スクリプトが param の塊で始まるので、先頭に自動では入れられません。param の後ろに手で入れてください。',
  'ps-input': 'スクリプトが $input か [Console]::OpenStandardInput() で標準入力を読むので、自動では入れられません。[Console]::In.ReadToEnd() で読む形にしてから、もう一度試してください。',
};

function planStatusline(target: 'statusline-install' | 'statusline-uninstall', env: SetupEnv): SetupPlan {
  const script = resolveStatuslineScript(env.claudeDir, env.homeDir).scriptPath;
  const read = script ? readUtf8Text(script) : null;
  if (script && read !== null && 'problem' in read) return stop(target, 'blocked', 'not-utf8', NOT_UTF8(script));
  const src = read !== null && 'text' in read ? read.text : null;
  if (!script || src === null) {
    if (target === 'statusline-uninstall') return stop(target, 'noop', 'absent', 'ステータスラインに hangar の行は入っていません。');
    return stop(target, 'blocked', 'no-script', STATUSLINE_REASON['no-script']!);
  }
  const backup = `${script}.bak-${BACKUP_STAMP}`;
  if (target === 'statusline-uninstall') {
    const r = planStatuslineRemoval(src);
    if (r.kind !== 'remove') return r.kind === 'absent' ? stop(target, 'noop', 'absent', 'ステータスラインに hangar の行は入っていません。') : stop(target, 'blocked', 'unreadable', STATUSLINE_REASON.unreadable!);
    const n = textDiff(src, r.next).filter((l) => l.k === 'del').length;
    return plan(target, { state: 'ready', reason: null, backup, files: [{ path: script, op: 'remove', what: 'statusline.remove', n, where: 'head', lines: textDiff(src, r.next), watch: sha(src) }] });
  }
  const r = planStatuslineSnippet(src, script, env.port);
  if (r.kind === 'same') return stop(target, 'noop', 'already', 'ステータスラインには hangar の行が入っています。');
  if (r.kind !== 'add' && r.kind !== 'replace') return stop(target, 'blocked', r.kind, STATUSLINE_REASON[r.kind]!);
  const n = statuslineSnippetFor(script, env.port).split('\n').length - 1;
  return plan(target, {
    state: 'ready', reason: null, backup,
    files: [
      { path: script, op: 'modify', what: r.kind === 'add' ? 'statusline.add' : 'statusline.replace', n, where: 'head', lines: textDiff(src, r.next), watch: sha(src) },
      { path: statuslineHeaderPath(env.home), op: 'own', what: 'statusline.header', where: null, lines: [], watch: null },
    ],
  });
}

/** 見立てを作る。何も書かない（hangar 自身の置き場とトークンは、無ければ用意する）。 */
export function planSetup(target: SetupTarget, env: SetupEnv): SetupPlan {
  switch (target) {
    case 'mcp-install':
    case 'mcp-uninstall':
      return planMcp(target, env);
    case 'shell-install':
    case 'shell-uninstall':
      return planShell(target, env);
    case 'statusline-install':
    case 'statusline-uninstall':
      return planStatusline(target, env);
  }
}

/** 書き込みの結果。changed は実際に書いたか、backups は取ったバックアップ、note は端末向けの添え書き（日本語）。 */
export type SetupWriteReply = { ok: true; result: { changed: boolean; backups: string[]; note: string | null } } | { ok: false; code: string; message: string };

const CHANGED = '見せた後に、書く先のファイルが変わりました。何も書いていません。もう一度、書く中身を確かめてください。';

class Changed extends Error {}

/**
 * 見立てを作り直し、指紋が expect と同じときだけ書く。expect が null なら比べない（端末から打ったとき）。
 * MCP は、ロックを取って読んだ mcpServers も、見立ての値と比べる（Claude Code が同じファイルを書いているため）。
 */
export async function runSetupWrite(target: SetupTarget, env: SetupEnv, expect: string | null): Promise<SetupWriteReply> {
  const p = planSetup(target, env);
  if (p.state === 'blocked') return { ok: false, code: p.reason!.code, message: p.reason!.message };
  if (expect !== null && p.fingerprint !== expect) return { ok: false, code: 'changed', message: CHANGED };
  if (p.state === 'noop') return { ok: true, result: { changed: false, backups: [], note: p.reason?.message ?? null } };
  env.beforeLock?.();
  const watch = p.files[0]!.watch;
  const check = (cur: Record<string, unknown>) => {
    const s = cur.mcpServers;
    if (mcpWatch(s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null) !== watch) throw new Changed(CHANGED);
  };
  const backups = (b: string | null | undefined) => (b ? [b] : []);
  const changedOr = (message: string): SetupWriteReply => (message.includes(CHANGED) ? { ok: false, code: 'changed', message: CHANGED } : { ok: false, code: 'write-failed', message });
  const now = (env.now ?? (() => new Date()))();
  try {
    switch (target) {
      case 'mcp-install': {
        const r = await runMcpInstall({ home: env.home, port: env.port, claudeJson: env.claudeJson, exec: env.exec, probe: env.probe, check, now });
        if (!r.wrote) return changedOr(r.message);
        // 書いた後の確かめ（トークンで認証を通せるか）に失敗しても、書いたことは書いたこととして返し、文を添える。
        return { ok: true, result: { changed: true, backups: backups(r.backup), note: r.ok ? null : r.message } };
      }
      case 'mcp-uninstall': {
        const r = await runMcpUninstall({ home: env.home, claudeJson: env.claudeJson, check, now });
        if (!r.ok) return changedOr(r.message);
        return { ok: true, result: { changed: true, backups: backups(r.backup), note: null } };
      }
      case 'shell-install': {
        ensureHome(env.home);
        ensureShellScript(env.home, { url: `http://127.0.0.1:${env.port}`, tokenFile: path.join(env.home, 'token'), tmuxPath: env.tmuxPath });
        const r = installShellHook(env.zshrc, shellHookLine(env.home, env.homeDir), now);
        return { ok: true, result: { changed: r.changed, backups: backups(r.backup), note: null } };
      }
      case 'shell-uninstall': {
        const r = uninstallShellHook(env.zshrc, now);
        return { ok: true, result: { changed: r.changed, backups: backups(r.backup), note: null } };
      }
      case 'statusline-install': {
        ensureHome(env.home);
        writeStatuslineHeaderFile(env.home, readOrCreateToken(env.home));
        const r = appendStatuslineSnippet(p.files[0]!.path, env.port, now);
        return { ok: true, result: { changed: r.changed, backups: backups(r.backup), note: null } };
      }
      case 'statusline-uninstall': {
        const r = removeStatuslineSnippet(p.files[0]!.path, now);
        return { ok: true, result: { changed: r.changed, backups: backups(r.backup), note: null } };
      }
    }
  } catch (e) {
    if (e instanceof Changed) return { ok: false, code: 'changed', message: CHANGED };
    return { ok: false, code: 'write-failed', message: e instanceof Error ? e.message : String(e) };
  }
}

const OP_WORD: Record<PlanFile['op'], string> = { create: '新規', modify: '変更', remove: '削除', own: 'hangar の置き場' };

/** 端末に出す見立て。ファイルごとに、操作、パス、+/- の差分を並べる。伏せた値は •••• にする。 */
export function formatSetupPlan(p: SetupPlan): string[] {
  if (p.state !== 'ready') return [p.reason?.message ?? ''];
  const out: string[] = ['次のとおり書き換えます（--dry-run なので、まだ何も書いていません）。'];
  for (const f of p.files) {
    out.push('', `[${OP_WORD[f.op]}] ${f.path}`);
    for (const l of f.lines) {
      const t = l.t.split(SECRET_MASK).join('••••');
      out.push(l.k === 'gap' ? `  …（ほか ${l.t} 行）` : `${l.k === 'add' ? '+' : l.k === 'del' ? '-' : ' '} ${t}`);
    }
  }
  if (p.backup) out.push('', `書く前に、バックアップを取ります: ${p.backup}（${BACKUP_STAMP} は書いた日時）`);
  return out;
}

/** CLI の既定の値で、この PC の環境を作る。 */
export function setupEnvFor(o: { home: string; claudeDir: string; claudeJson: string; zshrc: string; port: number; tmuxPath: string | null }): SetupEnv {
  return {
    ...o,
    // アプリから起こされた CLI には SHELL が無いことがある。そのときは利用者の記録から読む。
    loginShell: process.env.SHELL || os.userInfo().shell || '',
    platform: process.platform,
    homeDir: os.homedir(),
  };
}

export type SetupCommandFlags = { dryRun?: boolean; json?: boolean; yes?: boolean; expect?: string };

/**
 * --dry-run、--json、--expect の付いた呼び出しと、statusline uninstall の本体。戻り値は終了コード。
 * --dry-run は見立てだけ（--json なら `{ ok: true, plan }` の 1 行）。
 * --json の書き込みは聞けないので --yes を要る（殻は承諾の窓を経てから --yes を付ける）。
 * どちらも無ければ、見立てを見せて承諾を取ってから書く（端末から打ったとき）。
 */
export async function runSetupCommand(target: SetupTarget, env: SetupEnv, f: SetupCommandFlags, io: { log?: (s: string) => void; ask?: (q: string) => Promise<boolean>; interactive?: boolean } = {}): Promise<number> {
  const log = io.log ?? ((s: string) => console.log(s));
  if (f.dryRun) {
    const p = planSetup(target, env);
    if (f.json) log(JSON.stringify({ ok: true, plan: p }));
    else for (const l of formatSetupPlan(p)) log(l);
    return 0;
  }
  if (f.json && !f.yes) {
    log(JSON.stringify({ ok: false, code: 'confirm-required', message: '確認を取れないので、何も書いていません。--yes を付けてください' }));
    return 1;
  }
  if (!f.yes) {
    const p = planSetup(target, env);
    for (const l of formatSetupPlan(p)) log(l);
    if (p.state !== 'ready') return p.state === 'noop' ? 0 : 1;
    if (!(io.interactive ?? !!process.stdin.isTTY)) {
      log('標準入力が対話ではないので確認を取れません。端末から実行するか、--yes を付けてください');
      return 1;
    }
    if (!(await (io.ask ?? (async () => false))('書きますか？'))) {
      log('書きませんでした');
      return 1;
    }
  }
  const r = await runSetupWrite(target, env, f.expect ?? null);
  if (f.json) log(JSON.stringify(r));
  else if (!r.ok) log(r.message);
  else {
    log(r.result.changed ? '書きました。' : (r.result.note ?? '変えませんでした。'));
    for (const b of r.result.backups) log(`バックアップ: ${b}`);
    if (r.result.note && r.result.changed) log(r.result.note);
  }
  return r.ok ? 0 : 1;
}
