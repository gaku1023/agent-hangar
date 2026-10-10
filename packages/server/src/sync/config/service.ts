import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  CONFIG_BUNDLE_MIN_WORKER_COMPAT, configKey, isSafeKeyId,
  type ConfigApplyOrderDto, type ConfigApplyOrderEntryIn, type ConfigApplyOrderItemDto, type ConfigApproval, type ConfigBackupsDto, type ConfigHeldReason, type ConfigConflictDto,
  type ConfigInboxDto, type ConfigInboxItemDto, type ConfigItemKind, type ConfigOutgoingDto, type ConfigSyncDto, type ConfigUnsentDto, type ConfigUnsentItemDto, type FileMetaIn,
} from '@agent-hangar/shared';
import { diffLines } from '../../config/jsonTextEdit.ts';
import { touchRow } from '../../db/notify.ts';
import type { Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { msg, MessageError, type Message } from '../../i18n/message.ts';
import type { CloudClient } from '../client.ts';
import { decryptBuffer, encryptBuffer } from '../crypto.ts';
import { deleteApplyOrder, readApplyOrder, writeApplyOrder } from './applyOrder.ts';
import { listBackups } from './backups.ts';
import { ConfigBase } from './base.ts';
import { packBundle, unpackBundle, type BundleManifest, type ManifestItem } from './bundle.ts';
import { collectLocal, isBlocked, type Blocked, type Collected, type LocalItem, type UnsentCandidate } from './collect.ts';
import { parseItemId } from './ids.ts';
import { pruneInbox, readInbox, readInboxBlob, readInboxMeta, writeInbox, type InboxEntry } from './inbox.ts';
import { applyOrderPath, BUNDLE_PATH } from './paths.ts';
import { judge, type Action, type RemoteSnapshot } from './threeWay.ts';

/**
 * Claude Code の設定の同期（作り直した実装）の本体。docs/superpowers/specs/2026-10-09-config-sync-rebuild-design.md。
 *
 * データは PC ごとの束（sync/config/bundle.ts）で、1 回の送信で目録と中身が一致する。
 * 送るのは「手元の運ぶ項目」、受けるのは「他の PC の束を hangar の置き場に開いた写し（inbox）」で、
 * 3 方向の判定（sync/config/threeWay.ts）が、手元、相手、前回の共通（config_base）を比べて、新規、上書き、削除、競合を決める。
 *
 * このクラスは `~/.claude` に書かない（全体計画の D9）。読むのは collect.ts だけで、書くのは次の場所だけである。
 * - DB：config_snapshots（共有。PC ごとに 1 行）、config_base、config_unsent。
 * - hangar の置き場：inbox、適用の指示書（sync/config/paths.ts）。
 * - クラウド：`config/<端末>/.hangar/config-bundle.hgr` の 1 オブジェクト（旧実装の鍵とは別）。
 * 適用（~/.claude への書き込み、控え、基準の更新、競合の採り直し、世代へ戻す）は、指示書を読む殻の命令と hangar config apply の役目である。
 *
 * 既定は切である（settings.json の configBundleSync）。
 */

/** クラウドとの出し入れ。いまの同期のクライアントのうち、本文を運ぶ 2 つだけを使う。 */
export type ConfigCloud = Pick<CloudClient, 'putFile' | 'getFile' | 'lastWorkerCompat'>;

export type ConfigSyncDeps = {
  db: Db; deviceId: string; deviceName: string; claudeDir: string; home: string;
  cloud: ConfigCloud; key: Buffer;
  /** 送受信してよいか。スイッチが入っていて、同期が止まっていないこと。 */
  enabled: () => boolean;
  /** スイッチが入っているか（一時停止などは含まない）。状態の表示に使う。 */
  switchedOn: () => boolean;
  approval: () => ConfigApproval;
  now?: () => number;
  /** 取りに行って失敗した理由など、利用者に急ぎで見せないものの出し先。 */
  onError?: (message: string) => void;
};

/** 経路が status を付けて返す、利用者に見せる失敗。 */
export class ConfigSyncError extends MessageError {
  constructor(readonly status: 400 | 404, text: Message) { super(text); this.name = 'ConfigSyncError'; }
}

const EXEC_KINDS = new Set<ConfigItemKind>(['skills', 'commands', 'agents']);
const HEAD_CHARS = 400;
const MAX_DIFF_LINES = 200;
/** 手元の目録を行に載せる上限。クラウドの 1 行の上限（128 KiB）に収める。超えたら行には載せず、束の中の目録だけを使う。 */
const MAX_ROW_MANIFEST_BYTES = 96 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SENT_KEY = 'configBundleKey';
/** 取りに行って開けなかった束を、同じ指紋のまま取り直すまでの間。壊れた束を毎分取りに行って、クラウドの枠を使わないため。 */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** 判定に、見せる情報を足したもの。 */
type Resolved = {
  action: Action;
  kind: ConfigItemKind;
  label: string;
  size: number;
  marks: ManifestItem['marks'];
  head: string;
  held: ConfigHeldReason | null;
  target: string | null;
  fromDevice: string;
  local: LocalItem | null;
  remote: { item: ManifestItem; at: number } | null;
};

type SnapRow = { device_id: string; bundle_sha256: string; updated_at: number };

export class ConfigSyncService {
  private readonly base: ConfigBase;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** 前に見たときの「Worker の更新待ち」。変わったら画面へ配り直す。 */
  private lastWorkerPending: boolean | null = null;
  /** 前に見たときの「指示書の有無と世代の数」。適用と戻しはサーバの外（殻の命令、hangar config）で行われるので、変わったら画面へ配り直す。 */
  private lastApplyState: string | null = null;
  /** 開けなかった束の、端末ごとの行の指紋と時刻。起こし直すと忘れる。 */
  private readonly failed = new Map<string, { sha: string; at: number }>();

  constructor(private readonly deps: ConfigSyncDeps) {
    this.base = new ConfigBase(deps.db);
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
  /** いま並んでいる送受信が終わるまで待つ。 */
  async idle(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c.then(() => undefined, () => undefined);
      if (this.chain === c) return;
    }
  }
  /** 以後の送受信を断る。走っているものは待たない。 */
  stop(): void { this.stopped = true; }
  private touch(): void { touchRow(this.deps.db, 'config_state', 'self'); }

  /**
   * Worker が束の行を知る版に届いているか。
   * 配備済みの Worker は、config_snapshots の行を含む push を 400 で丸ごと断り、他の表の同期まで止める。
   * だから、Worker が名乗る版が CONFIG_BUNDLE_MIN_WORKER_COMPAT に届くまでは、束も行も送らない。
   * 版は同期の応答で分かる。まだ話していないあいだ（unknown）も送らないが、更新待ちとは言わない。
   */
  private workerState(): 'ready' | 'pending' | 'unknown' {
    const v = this.deps.cloud.lastWorkerCompat?.() ?? null;
    if (v === null) return 'unknown';
    return v >= CONFIG_BUNDLE_MIN_WORKER_COMPAT ? 'ready' : 'pending';
  }
  private workerPending(): boolean { return this.deps.switchedOn() && this.workerState() === 'pending'; }

  // ---- 手元 ----

  private allowedUnsent(): Map<string, string> {
    return new Map((this.deps.db.prepare('select id, content_sha256 from config_unsent where allowed = 1').all() as { id: string; content_sha256: string }[]).map((r) => [r.id, r.content_sha256]));
  }

  /** 手元の項目を集め、送らなかった項目の表を今の姿に合わせる。 */
  private collect(): Collected {
    const c = collectLocal({ db: this.deps.db, deviceId: this.deps.deviceId, claudeDir: this.deps.claudeDir, allowedUnsent: this.allowedUnsent() });
    if (this.refreshUnsent(c.unsent)) this.touch();
    return c;
  }

  /** config_unsent を候補に合わせる。変わったら true。「それでも送る」の印は、中身が同じ候補にだけ残る（collect が決める）。 */
  private refreshUnsent(cands: UnsentCandidate[]): boolean {
    const { db } = this.deps;
    const cur = new Map((db.prepare('select * from config_unsent').all() as { id: string; kind: string; item_id: string; label: string; reason: string; content_sha256: string; allowed: number; found_at: number }[]).map((r) => [r.id, r]));
    let changed = false;
    const write = db.transaction(() => {
      for (const c of cands) {
        const old = cur.get(c.id);
        if (old && old.kind === c.kind && old.item_id === c.itemId && old.label === c.label && old.reason === c.reason && old.content_sha256 === c.contentSha256 && old.allowed === (c.allowed ? 1 : 0)) continue;
        db.prepare(`insert into config_unsent (id, kind, item_id, label, reason, content_sha256, allowed, found_at) values (?,?,?,?,?,?,?,?)
          on conflict(id) do update set kind = excluded.kind, item_id = excluded.item_id, label = excluded.label, reason = excluded.reason, content_sha256 = excluded.content_sha256, allowed = excluded.allowed`)
          .run(c.id, c.kind, c.itemId, c.label, c.reason, c.contentSha256, c.allowed ? 1 : 0, old?.found_at ?? this.now());
        changed = true;
      }
      const keep = new Set(cands.map((c) => c.id));
      for (const id of cur.keys()) if (!keep.has(id)) { db.prepare('delete from config_unsent where id = ?').run(id); changed = true; }
    });
    write();
    return changed;
  }

  private ownRow(): { updated_at: number; bundle_sha256: string } | undefined {
    return this.deps.db.prepare('select updated_at, bundle_sha256 from config_snapshots where device_id = ? and deleted_at is null').get(this.deps.deviceId) as { updated_at: number; bundle_sha256: string } | undefined;
  }

  private deviceName(id: string): string {
    const r = this.deps.db.prepare('select name from devices where id = ?').get(id) as { name: string } | undefined;
    return r?.name ?? id;
  }

  /** この PC にあるプロジェクトの、メモリの置き場の slug と名前。 */
  private projectsHere(): Map<string, { slug: string; name: string }> {
    const rows = this.deps.db.prepare(`select r.project_id id, r.path path, p.name name from project_roots r join projects p on p.id = r.project_id
      where r.device_id = ? and r.deleted_at is null and p.deleted_at is null order by r.project_id`).all(this.deps.deviceId) as { id: string; path: string; name: string }[];
    const out = new Map<string, { slug: string; name: string }>();
    for (const r of rows) if (!out.has(r.id)) out.set(r.id, { slug: r.path.replace(/[^a-zA-Z0-9]/g, '-'), name: r.name });
    return out;
  }

  // ---- 送る一覧 ----

  outgoing(): ConfigOutgoingDto {
    const c = this.collect();
    const items = c.items.filter((i) => !i.withheld).map((i) => ({
      id: i.id, kind: i.kind, label: i.label, size: i.size, marks: i.marks,
      value: i.kind === 'settings' ? (i.content.length > 200 ? `${i.content.toString('utf8').slice(0, 200)}…` : i.content.toString('utf8')) : null,
    }));
    return { enabled: this.deps.switchedOn(), items, droppedKeys: c.dropped, unsentCount: this.unsentRows().length, lastSentAt: this.ownRow()?.updated_at ?? null };
  }

  // ---- 送る ----

  /** 手元の束を上げる。中身が前回と同じなら上げない。 */
  send(): Promise<{ sent: boolean; items: number }> {
    return this.enqueue(() => (this.stopped ? Promise.resolve({ sent: false, items: 0 }) : this.sendNow()));
  }

  private async sendNow(): Promise<{ sent: boolean; items: number }> {
    if (!this.deps.enabled()) return { sent: false, items: 0 };
    if (this.workerState() !== 'ready') return { sent: false, items: 0 };
    const { db, deviceId } = this.deps;
    const items = this.collect().items.filter((i) => !i.withheld);
    const own = this.ownRow();
    if (items.length === 0 && !own) return { sent: false, items: 0 };
    const contentKey = sha256(items.map((i) => `${i.id}\0${i.sha256}`).join('\n'));
    const last = db.prepare('select value from sync_state where key = ?').get(SENT_KEY) as { value: string } | undefined;
    if (own && last?.value === contentKey) return { sent: false, items: items.length };

    const now = this.now();
    const manifest: BundleManifest = { version: 1, deviceId, createdAt: now, items: items.map((i) => ({ id: i.id, kind: i.kind, sha256: i.sha256, size: i.size, marks: i.marks })) };
    const tar = packBundle(manifest, new Map(items.map((i) => [i.sha256, i.content])));
    const bundleSha = sha256(tar);
    const body = await encryptBuffer(this.deps.key, gzipSync(tar));
    const meta: FileMetaIn = { key: configKey(deviceId, BUNDLE_PATH), path: BUNDLE_PATH, kind: 'config', sha256: bundleSha, size: tar.length, mtime: now, encrypted: true };
    // 束を先に上げ、行は後に書く。行が降りた先で束が見つからない、という並びを作らない。
    await this.deps.cloud.putFile(meta, Readable.from([body]));
    const compact = JSON.stringify(items.map((i) => [i.id, i.sha256, i.size]));
    upsertShared(db, 'config_snapshots', {
      device_id: deviceId, bundle_sha256: bundleSha, bundle_size: tar.length, item_count: items.length,
      manifest: Buffer.byteLength(compact) <= MAX_ROW_MANIFEST_BYTES ? compact : null, deleted_at: null,
    }, deviceId, 'device_id');
    db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(SENT_KEY, contentKey);
    this.touch();
    return { sent: true, items: items.length };
  }

  // ---- 受け取る ----

  /** 他の PC の束を取りに行き、inbox に開く。行が新しくなった PC の束だけを取る。 */
  receive(): Promise<{ fetched: number; failed: number }> {
    return this.enqueue(() => (this.stopped ? Promise.resolve({ fetched: 0, failed: 0 }) : this.receiveNow()));
  }

  private async receiveNow(): Promise<{ fetched: number; failed: number }> {
    if (!this.deps.enabled()) return { fetched: 0, failed: 0 };
    const { db, home, deviceId } = this.deps;
    const rows = (db.prepare('select device_id, bundle_sha256, updated_at from config_snapshots where deleted_at is null and device_id <> ?').all(deviceId) as SnapRow[]).filter((r) => isSafeKeyId(r.device_id));
    pruneInbox(home, new Set(rows.map((r) => r.device_id)));
    let fetched = 0;
    let failed = 0;
    for (const row of rows) {
      if (readInboxMeta(home, row.device_id)?.forRowSha256 === row.bundle_sha256) continue;
      const before = this.failed.get(row.device_id);
      if (before && before.sha === row.bundle_sha256 && this.now() - before.at < RETRY_AFTER_FAILURE_MS) continue;
      try {
        const bundle = await this.fetchBundle(row.device_id);
        if (bundle.manifest.deviceId !== row.device_id) throw new Error('束の中の端末 ID が行の端末と違います');
        writeInbox(home, row.device_id, bundle.opened, { bundleSha256: bundle.sha, forRowSha256: row.bundle_sha256, at: row.updated_at, itemCount: bundle.manifest.items.length, skipped: bundle.opened.skipped });
        this.failed.delete(row.device_id);
        fetched++;
      } catch (e) {
        failed++;
        this.failed.set(row.device_id, { sha: row.bundle_sha256, at: this.now() });
        // 本文の断片が載りうる例外の中身は出さない。どの PC の束で、どの段で落ちたかだけを残す。
        this.deps.onError?.(`設定の束を開けませんでした（端末 ${row.device_id.slice(0, 8)}）: ${e instanceof Error ? e.name : 'Error'}`);
      }
    }
    this.reconcile();
    if (fetched > 0) this.touch();
    return { fetched, failed };
  }

  private async fetchBundle(fromDevice: string): Promise<{ opened: ReturnType<typeof unpackBundle>; manifest: BundleManifest; sha: string }> {
    const stored = await this.collectStream(await this.deps.cloud.getFile(configKey(fromDevice, BUNDLE_PATH)));
    const tar = gunzipSync(await decryptBuffer(this.deps.key, stored), { maxOutputLength: MAX_BUNDLE_BYTES });
    const opened = unpackBundle(tar);
    return { opened, manifest: opened.manifest, sha: sha256(tar) };
  }

  private async collectStream(s: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    let n = 0;
    for await (const chunk of s) {
      n += (chunk as Buffer).length;
      if (n > MAX_BUNDLE_BYTES) { s.destroy(); throw new Error('束が大きすぎます'); }
      parts.push(chunk as Buffer);
    }
    return Buffer.concat(parts);
  }

  /** 送受信を 1 回ずつ回す。失敗は onError へ渡して握る（定期の呼び出し用）。 */
  async tick(): Promise<void> {
    if (!this.deps.enabled()) return;
    try {
      await this.receive();
      await this.send();
      const pending = this.workerPending();
      if (pending !== this.lastWorkerPending) { this.lastWorkerPending = pending; this.touch(); }
      const applyState = `${fs.existsSync(applyOrderPath(this.deps.home))}:${listBackups(this.deps.home).length}`;
      if (this.lastApplyState !== null && applyState !== this.lastApplyState) this.touch();
      this.lastApplyState = applyState;
    } catch (e) {
      this.deps.onError?.(`設定の同期に失敗しました: ${e instanceof Error ? e.name : 'Error'}`);
    }
  }

  // ---- 判定 ----

  private snapshots(): RemoteSnapshot[] {
    return readInbox(this.deps.home).map((e: InboxEntry) => ({ deviceId: e.deviceId, at: e.meta.at, items: new Map(e.items.map((i) => [i.id, { sha256: i.sha256 }])) }));
  }

  /** 3 方向の判定を回し、手元と相手が同じだった項目を基準に書き、どこにも無くなった項目の基準を消す。 */
  private reconcile(): { actions: Action[]; local: Map<string, LocalItem>; blocked: Blocked } {
    const collected = this.collect();
    const items = new Map(collected.items.map((i) => [i.id, i]));
    const base = this.base.all();
    const j = judge({ local: new Map([...items].map(([id, i]) => [id, i.sha256])), base, remotes: this.snapshots() });
    const now = this.now();
    for (const [id, sha] of j.agreed) if (base.get(id) !== sha) this.base.set(id, sha, now);
    for (const id of j.forget) this.base.remove(id);
    return { actions: j.actions, local: items, blocked: collected.blocked };
  }

  private resolved(): Resolved[] {
    const { home } = this.deps;
    const { actions, local, blocked } = this.reconcile();
    const inbox = new Map(readInbox(home).map((e) => [e.deviceId, e]));
    const projects = this.projectsHere();
    const out: Resolved[] = [];
    for (const action of actions) {
      const parsed = parseItemId(action.id);
      if (!parsed) continue;
      const snap = inbox.get(action.fromDeviceId);
      const remoteItem = action.remoteSha256 === null ? undefined : snap?.items.find((i) => i.id === action.id);
      const localItem = local.get(action.id) ?? null;
      const ref = parsed.ref;
      let label: string;
      let target: string | null;
      let held: ConfigHeldReason | null = null;
      if (ref.type === 'file') { label = ref.rel; target = ref.rel; }
      else if (ref.type === 'settings') { label = ref.key; target = `settings.json#${ref.key}`; }
      else {
        const p = projects.get(ref.projectId);
        label = `${p?.name ?? ref.projectId}/${ref.rel}`;
        target = p ? `projects/${p.slug}/memory/${ref.rel}` : null;
        if (!p) held = 'no-project';
      }
      // 手元に同名のものがあるが運べない（リンク、大きすぎる、読めない、件数の上限）。「手元に無い」と見て create にすると、適用で手元を上書きする。
      if (held === null && isBlocked(blocked, action.id)) held = 'local-blocked';
      let head = '';
      if (remoteItem) {
        const blob = readInboxBlob(home, action.fromDeviceId, remoteItem.sha256);
        if (blob && !blob.includes(0)) head = blob.toString('utf8').slice(0, HEAD_CHARS);
      }
      out.push({
        action, kind: parsed.kind, label, target, held, head,
        size: remoteItem?.size ?? localItem?.size ?? 0,
        marks: remoteItem?.marks ?? localItem?.marks ?? [],
        fromDevice: this.deviceName(action.fromDeviceId),
        local: localItem,
        remote: remoteItem && snap ? { item: remoteItem, at: snap.meta.at } : null,
      });
    }
    return out;
  }

  inbox(): ConfigInboxDto {
    const approval = this.deps.approval();
    const items: ConfigInboxItemDto[] = this.resolved().map((r) => ({
      id: r.action.id, kind: r.kind, label: r.label, op: r.action.op,
      fromDeviceId: r.action.fromDeviceId, fromDevice: r.fromDevice, size: r.size, marks: r.marks, head: r.head, held: r.held,
      needsApproval: r.action.op !== 'delete' && EXEC_KINDS.has(r.kind) && approval === 'each',
    }));
    return { items, approval };
  }

  conflicts(): ConfigConflictDto[] {
    const text = (kind: ConfigItemKind, b: Buffer | null): string => {
      if (!b || b.includes(0)) return '';
      const s = b.toString('utf8');
      if (kind !== 'settings') return s;
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
    };
    return this.resolved().filter((r) => r.action.op === 'conflict').map((r) => {
      const remoteBlob = r.remote ? readInboxBlob(this.deps.home, r.action.fromDeviceId, r.remote.item.sha256) : null;
      return {
        id: r.action.id, kind: r.kind, label: r.label, marks: r.marks,
        local: r.local ? { deviceName: this.deps.deviceName, at: r.local.mtime, size: r.local.size } : null,
        remote: r.remote ? { deviceName: r.fromDevice, at: r.remote.at, size: r.remote.item.size } : null,
        diff: diffLines(text(r.kind, r.local?.content ?? null), text(r.kind, remoteBlob)).slice(0, MAX_DIFF_LINES),
      };
    });
  }

  // ---- 送らなかった項目 ----

  private unsentRows(): ConfigUnsentItemDto[] {
    return (this.deps.db.prepare('select id, kind, item_id, label, reason, allowed from config_unsent order by kind, id').all() as { id: string; kind: 'permission-rule' | 'secret'; item_id: string; label: string; reason: string; allowed: number }[])
      .map((r) => ({ id: r.id, kind: r.kind, itemId: r.item_id, label: r.label, reason: r.reason, allowed: r.allowed === 1 }));
  }

  unsent(): ConfigUnsentDto { return { items: this.unsentRows() }; }

  /** 「それでも送る」。項目に印を付けて、すぐ束を上げ直す。中身が変われば印は効かなくなる（collect が見る）。 */
  async sendUnsent(id: string): Promise<ConfigUnsentDto> {
    const row = this.deps.db.prepare('select id from config_unsent where id = ?').get(id);
    if (!row) throw new ConfigSyncError(404, msg('configSync.error.unsentNotFound', { id }));
    this.deps.db.prepare('update config_unsent set allowed = 1 where id = ?').run(id);
    this.touch();
    await this.send();
    return this.unsent();
  }

  // ---- 適用の指示書 ----

  /**
   * 承諾した項目を、適用の指示書として書く。前の指示書は置き換える。
   * 書くのは hangar の置き場だけで、~/.claude には書かない。
   */
  putApplyOrder(entries: ConfigApplyOrderEntryIn[]): ConfigApplyOrderDto {
    if (!Array.isArray(entries) || entries.length === 0) throw new ConfigSyncError(400, msg('configSync.error.emptyOrder'));
    const byId = new Map(this.resolved().map((r) => [r.action.id, r]));
    const seen = new Set<string>();
    const items: ConfigApplyOrderItemDto[] = [];
    for (const e of entries) {
      if (!e || typeof e.id !== 'string' || (e.take !== undefined && e.take !== 'remote' && e.take !== 'mine')) throw new ConfigSyncError(400, msg('configSync.error.badBody'));
      if (seen.has(e.id)) throw new ConfigSyncError(400, msg('configSync.error.duplicate', { id: e.id }));
      seen.add(e.id);
      const r = byId.get(e.id);
      if (!r) throw new ConfigSyncError(404, msg('configSync.error.unknownItem', { id: e.id }));
      if (r.held || r.target === null) throw new ConfigSyncError(400, msg('configSync.error.held', { id: e.id }));
      const take = e.take ?? 'remote';
      if (take === 'mine' && r.action.op !== 'conflict') throw new ConfigSyncError(400, msg('configSync.error.badTake', { id: e.id }));
      items.push({ id: r.action.id, kind: r.kind, op: r.action.op, take, fromDeviceId: r.action.fromDeviceId, sha256: r.action.remoteSha256 ?? '', target: r.target });
    }
    const order = writeApplyOrder(this.deps.home, this.deps.deviceId, items, this.now());
    this.touch();
    return order;
  }

  applyOrder(): ConfigApplyOrderDto | null { return readApplyOrder(this.deps.home); }

  /** 指示書を取り消す。無くてもよい。 */
  deleteApplyOrder(): void {
    if (deleteApplyOrder(this.deps.home)) this.touch();
  }

  // ---- 控えと状態 ----

  backups(): ConfigBackupsDto { return { generations: listBackups(this.deps.home) }; }

  dto(): ConfigSyncDto {
    const r = this.resolved();
    const order = readApplyOrder(this.deps.home);
    return {
      enabled: this.deps.switchedOn(),
      approval: this.deps.approval(),
      workerPending: this.workerPending(),
      incoming: r.filter((x) => x.action.op !== 'conflict' && !x.held).length,
      conflicts: r.filter((x) => x.action.op === 'conflict').length,
      held: r.filter((x) => x.held).length,
      unsent: this.unsentRows().length,
      backups: listBackups(this.deps.home).length,
      applyOrder: order ? { count: order.items.length, createdAt: order.createdAt } : null,
      lastSentAt: this.ownRow()?.updated_at ?? null,
    };
  }
}
