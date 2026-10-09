import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { listDevices } from '../db/queries.ts';
import { DEVICE_TOUCH_MS, measureShellHook, touchDevice } from './devicePresence.ts';

describe('自端末の生存の刻み', () => {
  let db: Db;
  const device = { id: 'dev-1', name: 'mini', platform: 'darwin' };
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });
  const row = () => db.prepare('select name, platform, last_seen_at, shell_hook, deleted_at from devices where id = ?').get(device.id) as Record<string, unknown> | undefined;

  it('自端末は起動のたびに devices へ書き込まれる', () => {
    touchDevice({ db, device, shellHook: () => ({ state: 'off' }), now: () => 1000 });
    expect(row()).toEqual({ name: 'mini', platform: 'darwin', last_seen_at: 1000, shell_hook: 'off', deleted_at: null });
    expect(listDevices(db, device.id).some((d) => d.self)).toBe(true);
  });

  it('刻み直すと、最終確認と包み方の状態が新しくなる', () => {
    touchDevice({ db, device, shellHook: () => ({ state: 'off' }), now: () => 1000 });
    touchDevice({ db, device, shellHook: () => ({ state: 'on' }), now: () => 2000 });
    expect(row()).toMatchObject({ last_seen_at: 2000, shell_hook: 'on' });
    expect((db.prepare('select count(*) c from devices').get() as { c: number }).c).toBe(1);
  });

  it('包み方の状態を測り、前に刻んだ値と違うときだけ刻み直す', () => {
    // Settings を開いたときに測り直す。CLI で入れた直後に開けば、ここで他の PC にも知らせる。
    let state: 'on' | 'off' = 'off';
    let touched = 0;
    const touch = (): void => { touched++; touchDevice({ db, device, shellHook: () => ({ state }) }); };
    const measure = () => measureShellHook({ db, deviceId: device.id, shellHook: () => ({ state, zshrc: '/z' }), touch });
    // まだ行が無い端末では刻まない。起動の手続きが刻む。
    expect(measure()).toEqual({ state: 'off', zshrc: '/z' });
    expect(touched).toBe(0);
    touch();
    measure();
    expect(touched).toBe(1);
    state = 'on';
    expect(measure().state).toBe('on');
    expect(touched).toBe(2);
    expect(row()).toMatchObject({ shell_hook: 'on' });
  });

  it('刻む間隔は 10 分である', () => {
    expect(DEVICE_TOUCH_MS).toBe(600_000);
  });
});
