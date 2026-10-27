import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isAutoDoneIdleDays, isCodexInjection, isLanguage, isLocalContext, isModelName, isOpencodeInjection, isSummaryEngine, type ConfigExecMark } from '@agent-hangar/shared';
import { loadSettings } from '../../../config/paths.ts';
import { applyHangarPrefs } from './hangarApplier.ts';
import { ApplyError, type ApplyPlan, type ApplyPlanItem, type ApplyResult, type PlannedOp } from '../apply.ts';
import { ConfigBase } from '../base.ts';
import { readApplyOrder } from '../applyOrder.ts';
import type { Collected, LocalItem } from '../collect.ts';
import { readInbox, readInboxBlob } from '../inbox.ts';
import type { ConfigTarget } from './types.ts';

/**
 * hangar の好み（設計書 7 章）。hangar の settings.json の鍵のうち、PC をまたいで同じでよいものを `hangar:<鍵>` で運ぶ。
 * 運ばないもの（PC ごと）：Codex・opencode の有効と横取り、パス（claudeDir、tmuxPath、nodePath、claudePath、workspaceRoot）、エディタ、
 * 端末アプリ、秘密（summaryApiKey）、要約器の宛先（lmStudio*）、接続先の準備、対象ごとの入切（configTargets）。
 * configTargets は「この PC で何を同期するか」の選びなので PC ごととして運ばない。
 * サーバが settings.json を書くので、殻の承認の窓は通さない。承認が要るのは configApproval の変更だけ（needsApproval）。
 */
export const HANGAR_TARGET_NAME = 'hangar';

const bool = (v: unknown): boolean => typeof v === 'boolean';
/** 運ぶ鍵と、その値の形の検査。 */
const FITS: Record<string, (v: unknown) => boolean> = {
  language: isLanguage,
  askStatusAtEnd: bool,
  liveHints: bool,
  defaultModel: (v) => v === null || isModelName(v),
  autoDone: bool,
  autoDoneIdleDays: isAutoDoneIdleDays,
  autoPark: bool,
  remoteControl: bool,
  summaryEngine: isSummaryEngine,
  summaryClaudeModel: isModelName,
  configApproval: (v) => v === 'each' || v === 'auto',
  opencodeInjection: isOpencodeInjection,
  opencodePermissionPreset: bool,
  opencodeLocalContext: isLocalContext,
  codexInjection: isCodexInjection,
};
export const HANGAR_PREF_KEYS: readonly string[] = Object.keys(FITS);

const PREFIX = 'hangar:';
const idOf = (key: string): string => `${PREFIX}${key}`;
const targetOf = (key: string): string => `hangar-settings.json#${key}`;
const keyOf = (id: string): string | null => {
  if (!id.startsWith(PREFIX)) return null;
  const k = id.slice(PREFIX.length);
  return Object.hasOwn(FITS, k) ? k : null;
};
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

export { setHangarPrefsApplier, type HangarPrefsApplier } from './hangarApplier.ts';

function collect(settingsPath: string): Collected {
  const out: Collected = { items: [], dropped: [], unsent: [], blocked: { ids: new Set(), prefixes: [] } };
  let raw: Record<string, unknown>;
  let mtime: number | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    mtime = Math.floor(fs.statSync(settingsPath).mtimeMs);
  } catch (e) {
    // 無いのは「運ぶものが無い」。読めない・壊れているときは、相手の項目で手元を上書きしないよう全部塞ぐ。
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.blocked.prefixes.push(PREFIX);
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { out.blocked.prefixes.push(PREFIX); return out; }
  for (const key of HANGAR_PREF_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!FITS[key]!(raw[key])) { out.blocked.ids.add(idOf(key)); continue; }
    const content = Buffer.from(JSON.stringify(raw[key]));
    const out_: LocalItem = { id: idOf(key), kind: 'hangar-pref', label: key, sha256: sha256(content), size: content.length, marks: [] as ConfigExecMark[], content, mtime, target: targetOf(key), withheld: null };
    out.items.push(out_);
  }
  return out;
}

type Entry = { id: string; key: string; op: 'create' | 'overwrite' | 'delete' | 'conflict'; take: 'remote' | 'mine'; sha: string; act: 'write' | 'remove' | 'keep'; value?: unknown };

/** 指示書のうち hangar の項目を、inbox と突き合わせて確かめる。1 つでも合わなければ何も書かずに断る。 */
function prepare(home: string): Entry[] {
  const order = readApplyOrder(home);
  if (!order) throw new ApplyError('no-order', '適用内容がありません。Hangar の設定で、適用する項目を選んでください。');
  const inbox = readInbox(home);
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const item of order.items) {
    if (!item.id.startsWith(PREFIX)) continue;
    const key = keyOf(item.id);
    if (!key || seen.has(item.id)) throw new ApplyError('broken-order', '適用内容が壊れています（項目が重なっているか、運ばない鍵です）。Hangar の設定で、適用する項目を選び直してください。');
    seen.add(item.id);
    if (item.target !== targetOf(key)) throw new ApplyError('unsafe', `適用内容の書き込み先が項目と一致しません（${item.id}）。書き込みません。`);
    const stale = (): ApplyError => new ApplyError('stale', `適用内容の項目が、現在の受信内容と一致しません（${item.id}）。他の PC の設定が更新された可能性があります。Hangar の設定で、適用する項目を選び直してください。`);
    const gone = item.sha256 === '';
    // 好みは「無い」を手元へ運ばない。相手が消した鍵は手元に残し、基準だけ外す（keep 扱い）。
    const act: Entry['act'] = item.take === 'mine' ? 'keep' : gone ? 'remove' : 'write';
    const e: Entry = { id: item.id, key, op: item.op, take: item.take, sha: item.sha256, act };
    if (act === 'write') {
      const holder = inbox.find((x) => x.deviceId === item.fromDeviceId);
      if (!holder?.items.some((i) => i.id === item.id && i.sha256 === item.sha256)) throw stale();
      const blob = readInboxBlob(home, item.fromDeviceId, item.sha256);
      if (!blob || sha256(blob) !== item.sha256) throw stale();
      try { e.value = JSON.parse(blob.toString('utf8')); } catch { throw new ApplyError('bad-content', `受信した設定の値を読み込めません（${item.id}）。`); }
      if (!FITS[key]!(e.value)) throw new ApplyError('bad-content', `受信した設定の値が、キーの型に合いません（${item.id}）。`);
    }
    out.push(e);
  }
  return out;
}

export const hangarTarget: ConfigTarget = {
  name: HANGAR_TARGET_NAME,
  owns: (id) => id.startsWith(PREFIX),
  parseId: (id) => { const key = keyOf(id); return key ? { kind: 'hangar-pref', ref: { type: 'hangar', key } } : null; },
  enabled: (ctx) => ctx.switches?.[HANGAR_TARGET_NAME] === true,
  collect: (ctx) => collect(ctx.hangarSettingsPath),
  planWrite: (o) => {
    const entries = prepare(o.home);
    const items: ApplyPlanItem[] = entries.map((e) => ({ id: e.id, kind: 'hangar-pref', op: e.op, take: e.take, label: e.key, marks: [], act: e.act }));
    const counts = { create: 0, overwrite: 0, delete: 0, conflictRemote: 0, conflictMine: 0 };
    for (const p of items) { if (p.op === 'conflict') counts[p.take === 'mine' ? 'conflictMine' : 'conflictRemote']++; else counts[p.op]++; }
    const plan: ApplyPlan = { createdAt: Date.now(), items, counts, byKind: { 'hangar-pref': items.length }, instructions: 0, exec: [] };
    return plan;
  },
  // 承認の窓には hangar の settings.json の差分として見せる。サーバが常に書き換えるので、書く直前の指紋には入れない（volatile）。
  planOps: (o): PlannedOp[] => {
    const patch: Record<string, unknown> = {};
    for (const e of prepare(o.home)) if (e.act === 'write') patch[e.key] = e.value;
    if (Object.keys(patch).length === 0) return [];
    return [{ rel: 'settings.json', path: path.join(o.home, 'settings.json'), after: JSON.stringify({ ...loadSettings(o.home), ...patch }, null, 2) + '\n', volatile: true }];
  },
  write: (o): ApplyResult => {
    const entries = prepare(o.home);
    const now = o.now ? o.now() : Date.now();
    const patch: Record<string, unknown> = {};
    for (const e of entries) if (e.act === 'write') patch[e.key] = e.value;
    const written = Object.keys(patch).length;
    if (written > 0) {
      try { applyHangarPrefs(o.home, patch); } catch (err) { throw new ApplyError('write-failed', `Hangar の設定を書き込めませんでした（${err instanceof Error ? err.message : String(err)}）。適用内容は削除していません。`); }
    }
    const base = new ConfigBase(o.db);
    o.db.transaction(() => {
      for (const e of entries) {
        if (e.act === 'write' || (e.act === 'keep' && e.sha !== '')) base.set(e.id, e.sha, now);
        else base.remove(e.id);
      }
    })();
    return { generation: null, written, removed: 0, keptMine: entries.filter((e) => e.act !== 'write').length, files: written > 0 ? ['settings.json'] : [] };
  },
  // 承認の仕方そのものを変える項目だけ、承認の仕方の設定に関わらず承認に掛ける（自動への切り替えを他の PC から黙って通さない）。
  // この口は値を受け取らないので、each へ戻す変更も承認になる（厳しい側へ倒す）。
  needsApproval: (item) => item.op !== 'delete' && item.id === idOf('configApproval'),
  isMachineBound: () => false,
};
