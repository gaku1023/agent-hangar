import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LaunchResultDto, RunDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../config/accounts.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { RunAccounts, switchAccount, type SwitchHost } from './accounts.ts';
import { RunError } from './errors.ts';

let db: Db;
let home: string;
let userHome: string;
let claudeDir: string;
let store: AccountStore;

beforeEach(() => {
  db = openDb(':memory:');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ra-home-'));
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ra-user-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ra-claude-'));
  fs.mkdirSync(path.join(claudeDir, 'projects'));
  store = new AccountStore({ home, primaryDir: claudeDir, homeDir: userHome });
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u-s1', cwd: home, home_device: 'd', last_activity_at: 1 }, 'd');
});
afterEach(() => {
  for (const d of [home, userHome, claudeDir]) fs.rmSync(d, { recursive: true, force: true });
});

const make = (withStore = true) => new RunAccounts({ db, claudeDir, store: withStore ? store : undefined });

/** そのアカウントで動かした run の行を足す。 */
function ranWith(account: string | undefined, startedAt: number): void {
  upsertShared(db, 'runs', { id: `r${startedAt}`, session_id: 's1', device_id: 'd', kind: 'start', tmux_name: `hangar-r${startedAt}`, pid: null, launch_params: JSON.stringify(account ? { account } : {}), started_at: startedAt, ended_at: startedAt, end_reason: 'exited', heartbeat_at: startedAt }, 'd');
}

describe('RunAccounts', () => {
  it('resolve：id が無ければいまのアカウント、知らない id は 400 で断る', () => {
    const a = store.add({ name: '別' });
    const ra = make();
    expect(ra.resolve(undefined)?.id).toBe('primary');
    store.setCurrent(a.id);
    expect(ra.resolve(undefined)?.id).toBe(a.id);
    expect(ra.resolve('primary')?.id).toBe('primary');
    expect(() => ra.resolve('nope')).toThrow(expect.objectContaining({ status: 400, message: 'アカウントが見つかりません' }));
  });

  it('アカウントの一覧を持たなければ、どの問いにも null を返す', () => {
    const ra = make(false);
    expect(ra.resolve(undefined)).toBeNull();
    expect(ra.resolve('nope')).toBeNull();
    expect(ra.lastUsed('s1')).toBeNull();
    expect(ra.byDir(claudeDir)).toBeNull();
    expect(ra.accountFor('s1')).toBe('primary');
  });

  it('accountFor：最後の run のアカウント。記録が無い、またはアカウントが消えていれば最初のアカウント', () => {
    const a = store.add({ name: '別' });
    const ra = make();
    expect(ra.accountFor('s1')).toBe('primary');
    ranWith(undefined, 1);
    expect(ra.accountFor('s1')).toBe('primary');
    ranWith(a.id, 2);
    expect(ra.accountFor('s1')).toBe(a.id);
    expect(ra.lastUsed('s1')?.id).toBe(a.id);
    store.remove(a.id);
    expect(ra.accountFor('s1')).toBe('primary');
    expect(ra.lastUsed('s1')?.id).toBe('primary');
  });

  it('byDir：登録済みの置き場ならそのアカウント、未登録なら null', () => {
    const a = store.add({ name: '別' });
    expect(make().byDir(a.dir)?.id).toBe(a.id);
    expect(make().byDir('/elsewhere')).toBeNull();
  });

  it('envFor：最初のアカウントは何も足さない。別のアカウントはリンクを張って置き場を渡す', () => {
    const a = store.add({ name: '別' });
    const ra = make();
    expect(ra.envFor(null)).toEqual({});
    expect(ra.envFor(store.get('primary')!)).toEqual({});
    expect(ra.envFor(a)).toEqual({ CLAUDE_CONFIG_DIR: a.dir });
    expect(fs.readlinkSync(path.join(a.dir, 'projects'))).toBe(path.join(claudeDir, 'projects'));
  });

  it('envFor：リンクの場所に別のものがあれば 400 で断り、触らない', () => {
    const a = store.add({ name: '別' });
    fs.mkdirSync(path.join(a.dir, 'projects'), { recursive: true });
    expect(() => make().envFor(a)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('置き場の projects が共有のリンクではありません') }));
    expect(fs.lstatSync(path.join(a.dir, 'projects')).isDirectory()).toBe(true);
  });
});

describe('switchAccount（run の寿命は偽物）', () => {
  const launched = { run: { id: 'r-new' } as RunDto, sessionId: 's1', tabs: [] } satisfies LaunchResultDto;
  /** 呼ばれた順を記録する偽の寿命。 */
  function host(o: { body?: boolean; background?: boolean; alive?: boolean; liveFor?: number; cwdOk?: boolean } = {}) {
    const calls: string[] = [];
    let liveLeft = o.liveFor ?? 0;
    const h: SwitchHost = {
      session: (id) => { if (id !== 's1') throw new RunError(404, 'セッションが見つかりません'); return { id: 's1', provider_session_id: 'u-s1', cwd: home }; },
      hasBody: () => o.body ?? true,
      precheck: () => { if (o.cwdOk === false) throw new RunError(400, 'ディレクトリが見つかりません: x'); },
      isBackground: () => o.background ?? false,
      isLive: () => liveLeft-- > 0,
      aliveRun: () => (o.alive ? ({ id: 'r-old' } as RunDto) : null),
      kill: (runId) => { calls.push(`kill ${runId}`); },
      resume: (sessionId, extra) => { calls.push(`resume ${sessionId} ${extra.account}`); return launched; },
      sleep: async (ms) => { calls.push(`sleep ${ms}`); },
    };
    return { h, calls };
  }

  it('動いている run を止め、レジストリから消えるのを待ってから、選んだアカウントで再開する', async () => {
    const a = store.add({ name: '別' });
    // 断る前の確かめで 1 回は読まれない（run があるので）。止めた後の 2 回はまだ残っている。
    const { h, calls } = host({ alive: true, liveFor: 2 });
    expect(await switchAccount(make(), h, 's1', a.id)).toBe(launched);
    expect(calls).toEqual(['kill r-old', 'sleep 250', 'sleep 250', `resume s1 ${a.id}`]);
  });

  it('止まっているセッションは、何も止めずに再開する', async () => {
    const a = store.add({ name: '別' });
    const { h, calls } = host();
    await switchAccount(make(), h, 's1', a.id);
    expect(calls).toEqual([`resume s1 ${a.id}`]);
  });

  it('断る理由は、止める前に確かめる', async () => {
    const a = store.add({ name: '別' });
    const cases: [Parameters<typeof host>[0], string, number, string][] = [
      [{ alive: true }, 'nope', 400, 'アカウントが見つかりません'],
      [{ alive: true }, 'primary', 409, 'このセッションはもうそのアカウントで動いています'],
      [{ alive: true, body: false }, a.id, 400, 'このセッションにはまだ本文がありません。そのアカウントで新しいセッションを始めてください'],
      [{ alive: true, cwdOk: false }, a.id, 400, 'ディレクトリが見つかりません: x'],
      [{ alive: true, background: true }, a.id, 409, 'バックグラウンドのセッションは、アカウントを切り替えられません。止めてから、そのアカウントで再開してください'],
      [{ alive: false, liveFor: 99 }, a.id, 409, 'このセッションは hangar の外で実行中です'],
    ];
    for (const [o, account, status, message] of cases) {
      const { h, calls } = host(o);
      await expect(switchAccount(make(), h, 's1', account), message).rejects.toThrow(expect.objectContaining({ status, message }));
      expect(calls, message).toEqual([]);
    }
  });

  it('知らないセッションは 404 で断る', async () => {
    await expect(switchAccount(make(), host().h, 'nope', 'primary')).rejects.toThrow(expect.objectContaining({ status: 404 }));
  });

  it('アカウントの一覧を持たなければ 400 で断る', async () => {
    await expect(switchAccount(make(false), host().h, 's1', 'primary')).rejects.toThrow(expect.objectContaining({ status: 400, message: 'アカウントが見つかりません' }));
  });

  it('止めたあとも 5 秒残り続けたら 409 で断り、再開しない', async () => {
    const a = store.add({ name: '別' });
    const { h, calls } = host({ alive: true, liveFor: 999 });
    await expect(switchAccount(make(), h, 's1', a.id)).rejects.toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining('前の Claude がまだ終わっていません') }));
    expect(calls[0]).toBe('kill r-old');
    expect(calls.filter((c) => c.startsWith('sleep'))).toHaveLength(20);
    expect(calls.some((c) => c.startsWith('resume'))).toBe(false);
  });
});
