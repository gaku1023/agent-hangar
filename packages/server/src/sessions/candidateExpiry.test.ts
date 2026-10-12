import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../db/open.ts';
import { CandidateExpiryWatch, EXPIRY_ANNOUNCED_KEY, expiryAnnounced, markExpiryAnnounced } from './candidateExpiry.ts';

const deps = (o: { announced?: boolean; clients?: number; confirmed?: string[] } = {}) => {
  let announced = o.announced ?? false;
  return {
    expire: vi.fn(() => ({ confirmed: o.confirmed ?? [], dropped: [] })),
    announced: () => announced,
    markAnnounced: vi.fn(() => { announced = true; }),
    clients: vi.fn(() => o.clients ?? 1),
    announce: vi.fn(),
    now: () => 1000,
  };
};

// 放っておかれた提案の片付け（2026-10-13 の決定、知らせの 9d）。入れた直後の 1 回目だけ、確定した件数をトーストで知らせる。
describe('CandidateExpiryWatch', () => {
  it('入れた直後の 1 回目は、画面がつながってから片付け、確定した件数を 1 度だけ知らせる', () => {
    const d = deps({ clients: 0, confirmed: ['a', 'b', 'c'] });
    const w = new CandidateExpiryWatch(d);
    w.tick();
    // 画面がつながっていなければ、知らせが届かないので待つ（まだ確定もしない）。
    expect(d.expire).not.toHaveBeenCalled();
    d.clients.mockReturnValue(1);
    w.tick();
    expect(d.expire).toHaveBeenCalledWith(1000);
    expect(d.announce).toHaveBeenCalledWith(3);
    expect(d.markAnnounced).toHaveBeenCalledTimes(1);
    // 2 回目からは、確定しても知らせない。
    w.tick();
    expect(d.expire).toHaveBeenCalledTimes(2);
    expect(d.announce).toHaveBeenCalledTimes(1);
  });
  it('1 回目に確定したものが無ければ、知らせずに済んだ印だけ付ける', () => {
    const d = deps({ confirmed: [] });
    new CandidateExpiryWatch(d).tick();
    expect(d.announce).not.toHaveBeenCalled();
    expect(d.markAnnounced).toHaveBeenCalledTimes(1);
  });
  it('済んだ印があれば、画面がつながっていなくても黙って片付ける', () => {
    const d = deps({ announced: true, clients: 0, confirmed: ['a'] });
    new CandidateExpiryWatch(d).tick();
    expect(d.expire).toHaveBeenCalledTimes(1);
    expect(d.announce).not.toHaveBeenCalled();
  });
  it('片付けが失敗しても投げず、記録に残す', () => {
    const log = vi.fn();
    const d = { ...deps({ announced: true }), expire: vi.fn(() => { throw new Error('db is locked'); }), log };
    expect(() => new CandidateExpiryWatch(d).tick()).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db is locked'));
  });
});

describe('済んだ印', () => {
  it('端末だけの表（settings_local）に置き、開き直しても残る', () => {
    const db = openDb(':memory:');
    expect(expiryAnnounced(db)).toBe(false);
    markExpiryAnnounced(db);
    expect(expiryAnnounced(db)).toBe(true);
    expect(db.prepare('select value from settings_local where key = ?').get(EXPIRY_ANNOUNCED_KEY)).toEqual({ value: '1' });
    // 同期の差分には積まない（端末ごとの印なので）。
    expect(db.prepare("select count(*) n from changes where table_name = 'settings_local'").get()).toEqual({ n: 0 });
  });
});
