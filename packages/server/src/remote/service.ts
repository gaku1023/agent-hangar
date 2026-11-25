import { randomUUID } from 'node:crypto';
import { parseDeviceStatus, type RemoteTabDto, type ServerEvent } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { ownerOf } from '../peer/screenWake.ts';
import type { RemoteShellConnector, RemoteShellHandle, RemoteShellIo } from '../pty/relay.ts';
import { RemoteShellLink, type RemoteShellLinkDeps, type RemoteShellLinkOptions } from './link.ts';
import { remoteSessionName } from './sshCommand.ts';
import { closeRemoteTab, getRemoteHost, getRemoteTab, insertRemoteTab, listOpenRemoteTabs, listRemoteHosts, setRemoteHost, type RemoteTabRow } from './store.ts';

/**
 * SSH のシェルタブの持ち主（docs/design.md「ほかの PC の会話のシェルタブ（SSH）」）。
 * タブの行（手元だけの表）を開け閉めし、画面の WS ごとに RemoteShellLink を 1 本ずつ作る。
 * WS が閉じたら link を detach して相手のセッションを残し、タブを閉じたときだけ kill-session を打つ。
 */

/** このサービスが配る出来事。行のイベントではないので、hub から直に配る。 */
export type RemoteShellEvent = Extract<ServerEvent, { type: 'remoteTab.upsert' | 'remoteTab.closed' | 'remoteHost.changed' }>;

export type LinkLike = Pick<RemoteShellLink, 'start' | 'retry' | 'write' | 'resize' | 'detach' | 'close' | 'closeUnattached'>;

export type RemoteShellServiceDeps = {
  db: Db;
  selfId: string;
  broadcast(ev: RemoteShellEvent): void;
  linkDeps: RemoteShellLinkDeps;
  now?: () => number;
  newId?: () => string;
  /** link の作り方。試験で差し替える。 */
  makeLink?: (o: RemoteShellLinkOptions, d: RemoteShellLinkDeps) => LinkLike;
};

/** 端末の大きさの初めの値。画面が resize を送るまでの間だけ使う。 */
const INITIAL_COLS = 120;
const INITIAL_ROWS = 40;
const HOST_MAX = 253;

/**
 * 上書きの Host 名として通すか。ssh の引数に渡るので、頭の -（オプションに取られる）、空白、引用符、制御文字を断る。
 * 空は「外す」の意味にしないで断る。外すのは null。
 */
export function validSshHost(h: unknown): h is string {
  if (typeof h !== 'string' || h === '' || h.length > HOST_MAX) return false;
  if (h.startsWith('-')) return false;
  return !/[\s'"`\u0000-\u001f\u007f]/.test(h);
}

const toDto = (r: RemoteTabRow): RemoteTabDto => ({ id: r.id, sessionId: r.sessionId, deviceId: r.deviceId, title: r.title, createdAt: r.createdAt });

export class RemoteShellService {
  private readonly live = new Map<string, Set<LinkLike>>();
  private pending = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly makeLink: (o: RemoteShellLinkOptions, d: RemoteShellLinkDeps) => LinkLike;
  private readonly deviceOf;
  private readonly cwdOf;

  constructor(private readonly deps: RemoteShellServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 16));
    this.makeLink = deps.makeLink ?? ((o, d) => new RemoteShellLink(o, d));
    this.deviceOf = deps.db.prepare('select platform, status from devices where id = ? and deleted_at is null');
    this.cwdOf = deps.db.prepare('select cwd from sessions where id = ?');
  }

  tabs(): RemoteTabDto[] { return listOpenRemoteTabs(this.deps.db).map(toDto); }
  hosts(): Record<string, string> { return listRemoteHosts(this.deps.db); }

  /** 会話の持ち主の PC（最後の run の PC）にタブを開く。持ち主が手元か、引けなければ null。sshd の有無はここでは見ない。 */
  open(sessionId: string): RemoteTabDto | null {
    const owner = ownerOf(this.deps.db, this.deps.selfId, sessionId);
    if (!owner) return null;
    const id = this.newId();
    insertRemoteTab(this.deps.db, { id, sessionId, deviceId: owner.deviceId, remoteName: remoteSessionName(id), title: owner.name, createdAt: this.now() });
    const tab = toDto(getRemoteTab(this.deps.db, id)!);
    this.deps.broadcast({ type: 'remoteTab.upsert', tab });
    return tab;
  }

  /**
   * タブを閉じる。行はすぐ閉じて出来事を配り、相手の kill-session は後ろで打つ（返す約束で待てる）。知らないタブは null。
   * つないでいる link があれば 1 本で close（kill-session）し、残りは detach する。無ければ一時の link で閉じる。
   */
  close(tabId: string): Promise<void> | null {
    const row = getRemoteTab(this.deps.db, tabId);
    if (!row) return null;
    const wasOpen = row.closedAt === null;
    closeRemoteTab(this.deps.db, tabId, this.now());
    if (wasOpen) this.deps.broadcast({ type: 'remoteTab.closed', id: tabId });
    const links = [...(this.live.get(tabId) ?? [])];
    this.live.delete(tabId);
    let done: Promise<void>;
    if (links.length > 0) {
      const [first, ...rest] = links;
      for (const l of rest) l.detach();
      done = first!.close();
    } else if (wasOpen) {
      done = this.makeLink(this.optionsFor(row, { onStatus: () => {}, onData: () => {}, onEnded: () => {} }), this.deps.linkDeps).closeUnattached();
    } else {
      done = Promise.resolve();
    }
    return this.track(done);
  }

  /** 上書きの Host 名を置く。null で外す。検査は呼ぶ側（validSshHost）。 */
  setHost(deviceId: string, host: string | null): void {
    setRemoteHost(this.deps.db, deviceId, host, this.now());
    this.deps.broadcast({ type: 'remoteHost.changed', deviceId, host });
  }

  /** relay が WS ごとに呼ぶ。開いているタブだけを返す。 */
  connector(tabId: string): RemoteShellConnector | null {
    const row = getRemoteTab(this.deps.db, tabId);
    if (!row || row.closedAt !== null) return null;
    return { open: (io) => this.attach(row, io) };
  }

  /** 後ろで走っている閉じる処理が終わるまで待つ（試験と終わりの待ち合わせ用）。 */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** 全部の link を detach する（サーバを閉じるとき）。相手のセッションは残す。 */
  stop(): void {
    for (const set of this.live.values()) for (const l of set) l.detach();
    this.live.clear();
  }

  private attach(row: RemoteTabRow, io: RemoteShellIo): RemoteShellHandle {
    const link = this.makeLink(this.optionsFor(row, {
      onStatus: (m) => { io.onStatus(m); },
      onData: (d) => { io.onData(d); },
      // 利用者が exit した。手元のシェルタブがシェルの終わりで閉じるのと同じく、タブを閉じる。
      onEnded: () => { io.onEnded(); this.close(row.id); },
    }), this.deps.linkDeps);
    let set = this.live.get(row.id);
    if (!set) { set = new Set(); this.live.set(row.id, set); }
    set.add(link);
    return {
      start: () => link.start(),
      retry: () => link.retry(),
      write: (d) => { link.write(d); },
      resize: (c, r) => { link.resize(c, r); },
      detach: () => {
        const s = this.live.get(row.id);
        if (s?.delete(link) && s.size === 0) this.live.delete(row.id);
        link.detach();
      },
    };
  }

  private optionsFor(row: RemoteTabRow, io: RemoteShellIo): RemoteShellLinkOptions {
    const d = this.deviceOf.get(row.deviceId) as { platform: string; status: string | null } | undefined;
    const s = this.cwdOf.get(row.sessionId) as { cwd: string } | undefined;
    return {
      tabId: row.id, deviceId: row.deviceId, peerPlatform: d?.platform ?? '', status: parseDeviceStatus(d?.status ?? null),
      override: getRemoteHost(this.deps.db, row.deviceId), cwd: s?.cwd ?? '', cols: INITIAL_COLS, rows: INITIAL_ROWS,
      onStatus: io.onStatus, onData: io.onData, onEnded: io.onEnded,
    };
  }

  private track(p: Promise<void>): Promise<void> {
    const q = p.catch((e: unknown) => { console.error('[remote] could not close the remote shell', e instanceof Error ? e.message : String(e)); });
    this.pending.add(q);
    void q.finally(() => { this.pending.delete(q); });
    return q;
  }
}
