import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigExecMark } from '@agent-hangar/shared';
import { ApplyError } from '../apply.ts';
import { MAX_ITEM_BYTES } from '../bundle.ts';
import type { Collected, LocalItem, UnsentCandidate } from '../collect.ts';
import { findSecret } from '../secrets.ts';
import { canonicalJson } from '../settingsSort.ts';
import { analyzeCommand, fromPortable, hostOs, isCarriedHookFile, toPortable, type CommandRefs, type HostOs } from './hookCommands.ts';
import { planItemOps, planItems, readSettingsForCollect, writeItems, type FileWrite, type ItemSpec } from './settingsItemWriter.ts';
import { CLAUDE_STORE } from './stores.ts';
import type { ConfigTarget, TargetContext } from './types.ts';

/**
 * Claude の hooks と statusLine（SPEC 6 章、決定 D6）。settings.json の鍵と、command が指す `~/.claude` の下の台本を 1 つの項目で運ぶ。
 *
 * - 項目は `claude-hooks:hooks`（kind claude-hooks、鍵 hooks）と `claude-hooks:statusline`（kind claude-statusline、鍵 statusLine）の 2 つ。
 *   中身は `{ v: 1, value: <鍵の値>, files: [{ rel, b64, x? }] }` の正規化した JSON で、指紋は鍵とファイルを合わせて取る。
 *   id を `settings:hooks` にしないのは、古い版が `settings:hooks` を「運ばない鍵」として読み飛ばすからで、
 *   別の頭にすれば、古い版の束に無いことが消去に見えない（claude より前の別の対象にする）。
 * - command のパスは、`~`、`$HOME`、`%USERPROFILE%`、ホームの絶対パスのどれも `~/.claude/…` に読み替えて判定する。
 *   ホームの絶対パスだけは目印（__HANGAR_HOME__）にして運び、受け手が自分のホームに戻して書く。
 * - 送り手が運ばないもの：`~/.claude` の外を指す hook、hangar の包みを指すもの。受け手の手元にあれば、書き戻しで残す。
 * - 受け手が保留するもの：送り手と OS が違う、`~/.claude` の外を指す、hangar の包みを指す（別の版から届いたときの備え）。
 *   保留は holdOfHooks で判定でき、書き戻し（planWrite、write）も ApplyError で断る。
 * - 入切は設定の `configTargets`（対象名→真偽）で、既定は切。承認は設定が each のあいだ、消去も含めて全部。
 */
export const CLAUDE_HOOKS_NAME = 'claude-hooks';
export const HOOKS_ID = 'claude-hooks:hooks';
export const STATUSLINE_ID = 'claude-hooks:statusline';

const KEY_OF: Readonly<Record<string, 'hooks' | 'statusLine'>> = { [HOOKS_ID]: 'hooks', [STATUSLINE_ID]: 'statusLine' };

export type HookHold = 'other-os' | 'outside-claude' | 'hangar-wrapper';

type Handler = Record<string, unknown>;
type Payload = { v: 1; value: unknown; files: { rel: string; b64: string; x?: true }[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** hooks の値の中の handler を 1 つずつ変える。fn が null を返したものは落とし、空になった組とイベントも落とす。形の分からない部分は落とす。 */
function rebuildHooks(hooks: Record<string, unknown>, fn: (h: Handler) => Handler | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === '__proto__' || !Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isObject(g)) continue;
      if (Array.isArray(g.hooks)) {
        const hs = g.hooks.filter(isObject).map(fn).filter((h): h is Handler => h !== null);
        if (hs.length > 0) kept.push({ ...g, hooks: hs });
      } else {
        const h = fn(g);
        if (h) kept.push(h);
      }
    }
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

function eachHandler(hooks: Record<string, unknown>, fn: (h: Handler) => void): void {
  rebuildHooks(hooks, (h) => { fn(h); return h; });
}

type Ctx = { userHome: string; os: HostOs };

const refsOf = (h: Handler, c: Ctx): CommandRefs | null => (typeof h.command === 'string' ? analyzeCommand(h.command, c.userHome, c.os) : null);
/** 運ばない（受け手の手元にあれば残す）handler か。 */
const staysLocal = (h: Handler, c: Ctx): boolean => { const r = refsOf(h, c); return r !== null && (r.outside || r.wrapper); };
const mapCommand = (h: Handler, fn: (cmd: string) => string): Handler => (typeof h.command === 'string' ? { ...h, command: fn(h.command) } : h);

/** 値の中の command が指す `~/.claude` の下のファイル（相対パス）を集める。 */
function filesOfValue(key: 'hooks' | 'statusLine', value: unknown, c: Ctx): Set<string> {
  const out = new Set<string>();
  const add = (h: Handler): void => { for (const f of refsOf(h, c)?.files ?? []) out.add(f); };
  if (key === 'hooks') { if (isObject(value)) eachHandler(value, add); } else if (isObject(value)) add(value);
  return out;
}

/** 受け手の保留。内容を見て、書いてはいけない理由を返す。 */
export function holdOfHooks(content: Buffer, o: { senderOs: HostOs | undefined; os: HostOs; userHome: string; id?: string }): HookHold | null {
  if (o.senderOs !== o.os) return 'other-os';
  let payload: unknown;
  try { payload = JSON.parse(content.toString('utf8')); } catch { return null; }
  if (!isObject(payload)) return null;
  const c: Ctx = { userHome: o.userHome, os: o.os };
  const bad = (h: Handler): HookHold | null => { const r = refsOf(h, c); return r === null ? null : r.wrapper ? 'hangar-wrapper' : r.outside ? 'outside-claude' : null; };
  const found: { hold: HookHold | null } = { hold: null };
  const note = (h: Handler): void => { const b = bad(h); if (b && (found.hold === null || b === 'hangar-wrapper')) found.hold = b; };
  const v = payload.value;
  if (isObject(v)) {
    if (typeof v.command === 'string') note(v);
    else eachHandler(v, note);
  }
  return found.hold;
}

const HOLD_TEXT: Record<HookHold, string> = {
  'other-os': '送信元の PC と OS が違うため、hooks と statusLine は書き込みません（OS ごとにコマンドの書き方が違うため）。',
  'outside-claude': 'hooks のコマンドが ~/.claude の外を指しているため、書き込みません。',
  'hangar-wrapper': 'hooks のコマンドが Hangar 自身のラッパーを指しているため、書き込みません。',
};

function parsePayload(blob: Buffer, id: string): Payload {
  const bad = (): ApplyError => new ApplyError('bad-content', `受信した hooks の形式を読み込めません（${id}）。`);
  let v: unknown;
  try { v = JSON.parse(blob.toString('utf8')); } catch { throw bad(); }
  if (!isObject(v) || v.v !== 1 || !Array.isArray(v.files)) throw bad();
  const files: Payload['files'] = [];
  for (const f of v.files) {
    if (!isObject(f) || typeof f.rel !== 'string' || typeof f.b64 !== 'string' || (f.x !== undefined && f.x !== true)) throw bad();
    files.push({ rel: f.rel, b64: f.b64, ...(f.x === true ? { x: true as const } : {}) });
  }
  return { v: 1, value: v.value, files };
}

function makeSpec(id: string, key: 'hooks' | 'statusLine', c: Ctx): ItemSpec {
  return {
    key,
    decode(blob, from) {
      const payload = parsePayload(blob, id);
      const valueOk = key === 'hooks' ? isObject(payload.value) : isObject(payload.value) && typeof payload.value.command === 'string';
      if (!valueOk) throw new ApplyError('bad-content', `受信した hooks の値が、キーの型に合いません（${id}）。`);
      const hold = holdOfHooks(blob, { senderOs: from.senderOs, os: c.os, userHome: c.userHome, id });
      if (hold) throw new ApplyError('unsafe', HOLD_TEXT[hold]);
      const value = key === 'hooks'
        ? rebuildHooks(payload.value as Record<string, unknown>, (h) => mapCommand(h, (s) => fromPortable(s, c.userHome)))
        : mapCommand(payload.value as Handler, (s) => fromPortable(s, c.userHome));
      // 書いてよいファイルは、command が指す `~/.claude` の下の台本だけ。束がほかの場所へ書かせようとしても断る。
      const allowed = filesOfValue(key, value, c);
      const files: FileWrite[] = [];
      for (const f of payload.files) {
        if (!isCarriedHookFile(f.rel) || !allowed.has(f.rel) || files.some((x) => x.rel === f.rel)) throw new ApplyError('bad-content', `受信した hooks に、書き込めないファイルがあります（${f.rel}）。書き込みません。`);
        files.push({ rel: f.rel, data: Buffer.from(f.b64, 'base64'), exec: f.x === true });
      }
      return { value, files };
    },
    merge(cur, remote) {
      if (key === 'statusLine') {
        if (remote !== undefined) return remote;
        const mine = cur.statusLine;
        return isObject(mine) && staysLocal(mine, c) ? mine : undefined;
      }
      // 手元だけの hook（運ばないもの）は、届いた hooks に足して残す。
      const mine = isObject(cur.hooks) ? rebuildHooks(cur.hooks, (h) => (staysLocal(h, c) ? h : null)) : {};
      const merged = isObject(remote) ? structuredClone(remote) : {};
      for (const [event, groups] of Object.entries(mine)) {
        const target = Array.isArray(merged[event]) ? (merged[event] as unknown[]) : (merged[event] = []) as unknown[];
        for (const g of groups as Record<string, unknown>[]) {
          const same = target.find((t): t is Record<string, unknown> => isObject(t) && Array.isArray(t.hooks) && Array.isArray(g.hooks) && t.matcher === g.matcher);
          if (same && Array.isArray(g.hooks)) {
            for (const h of g.hooks as Handler[]) if (!(same.hooks as Handler[]).some((x) => canonicalJson(x) === canonicalJson(h))) (same.hooks as Handler[]).push(h);
          } else if (!target.some((t) => canonicalJson(t) === canonicalJson(g))) target.push(g);
        }
      }
      return Object.keys(merged).length > 0 ? merged : undefined;
    },
    marks: (files): ConfigExecMark[] => (files.length > 0 ? ['shell', 'script'] : ['shell']),
  };
}

/** 項目の中身を作る。ファイルは claudeDir から読む（リンク、普通でないもの、大きすぎるものは入れない）。 */
function buildPayload(key: 'hooks' | 'statusLine', value: unknown, claudeDir: string, c: Ctx): { content: Buffer; texts: string[]; files: number } | null {
  const portable = key === 'hooks'
    ? rebuildHooks(value as Record<string, unknown>, (h) => (staysLocal(h, c) ? null : mapCommand(h, (s) => toPortable(s, c.userHome, c.os))))
    : staysLocal(value as Handler, c) ? null : mapCommand(value as Handler, (s) => toPortable(s, c.userHome, c.os));
  if (portable === null || (key === 'hooks' && Object.keys(portable).length === 0)) return null;
  const files: Payload['files'] = [];
  const texts = [JSON.stringify(portable)];
  for (const rel of [...filesOfValue(key, portable, c)].sort()) {
    if (!isCarriedHookFile(rel)) continue;
    const abs = path.join(claudeDir, ...rel.split('/'));
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ITEM_BYTES) continue;
      const data = fs.readFileSync(abs);
      files.push({ rel, b64: data.toString('base64'), ...(process.platform !== 'win32' && (st.mode & 0o111) !== 0 ? { x: true as const } : {}) });
      if (!data.includes(0)) texts.push(data.toString('utf8'));
    } catch { /* 無い、読めない台本は入れない（command は運ぶ） */ }
  }
  const payload: Payload = { v: 1, value: portable, files };
  return { content: Buffer.from(canonicalJson(payload)), texts, files: files.length };
}

function collectHooks(ctx: TargetContext, c: Ctx): Collected {
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } };
  const blockBoth = (): void => { out.blocked.ids.add(HOOKS_ID); out.blocked.ids.add(STATUSLINE_ID); };
  const read = readSettingsForCollect(ctx.claudeDir);
  if (read === 'absent') return out;
  if (read === 'blocked') { blockBoth(); return out; }
  const { json, mtime } = read;
  for (const [id, key] of Object.entries(KEY_OF) as [string, 'hooks' | 'statusLine'][]) {
    const raw = json[key];
    if (!(key === 'hooks' ? isObject(raw) : isObject(raw) && typeof raw.command === 'string')) continue;
    const built = buildPayload(key, raw, ctx.claudeDir, c);
    if (!built) continue;
    if (built.content.length > MAX_ITEM_BYTES) { out.blocked.ids.add(id); continue; }
    const hash = sha256(built.content);
    let withheld: LocalItem['withheld'] = null;
    for (const text of built.texts) {
      const found = findSecret(text);
      if (!found) continue;
      const uid = `secret:${id}`;
      const allowed = ctx.allowedUnsent.get(uid) === hash;
      const row: UnsentCandidate = { id: uid, kind: 'secret', itemId: id, label: key, reason: `secret:${found}`, contentSha256: hash, allowed };
      out.unsent.push(row);
      if (!allowed) withheld = 'secret';
      break;
    }
    out.items.push({ id, kind: id === HOOKS_ID ? 'claude-hooks' : 'claude-statusline', label: key, sha256: hash, size: built.content.length, marks: built.files > 0 ? ['shell', 'script'] : ['shell'], content: built.content, mtime, target: `settings.json#${key}`, withheld });
  }
  return out;
}

/** 試験が、ホームと OS を差し替えて対象を作る。 */
export function createClaudeHooksTarget(o: { userHome?: () => string; os?: HostOs } = {}): ConfigTarget {
  // 書くときは、殻と CLI が渡す利用者のホームとこの PC の OS（WritePaths）を先に使う。
  const ctx = (w?: { userHome?: string; hostOs?: HostOs }): Ctx => ({ userHome: w?.userHome ?? (o.userHome ?? os.homedir)(), os: w?.hostOs ?? o.os ?? hostOs() });
  const specs = (w?: { userHome?: string; hostOs?: HostOs }): Map<string, ItemSpec> => new Map(Object.entries(KEY_OF).map(([id, key]) => [id, makeSpec(id, key, ctx(w))]));
  return {
    name: CLAUDE_HOOKS_NAME,
    owns: (id) => id === HOOKS_ID || id === STATUSLINE_ID,
    parseId: (id) => (id === HOOKS_ID ? { kind: 'claude-hooks', ref: { type: 'settings', key: 'hooks' } } : id === STATUSLINE_ID ? { kind: 'claude-statusline', ref: { type: 'settings', key: 'statusLine' } } : null),
    enabled: (t) => t.switches?.[CLAUDE_HOOKS_NAME] === true,
    collect: (t) => collectHooks(t, ctx()),
    planWrite: (w) => planItems(w, specs(w)),
    write: (w) => writeItems(w, specs(w)),
    planOps: (w, read) => planItemOps(w, specs(w), read),
    store: CLAUDE_STORE,
    // 実行されるものなので、設定が each のあいだは消去も承認に掛ける。
    needsApproval: (_item, approval) => approval === 'each',
    isMachineBound: () => false,
  };
}

export const claudeHooksTarget: ConfigTarget = createClaudeHooksTarget();
