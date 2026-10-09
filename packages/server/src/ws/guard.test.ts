import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { guardUpgrades, WS_PATHS } from './guard.ts';

describe('upgrade の番人', () => {
  it('番人は attach している経路をすべて許す', () => {
    // 番人の集合から経路が抜けると、101 を返した直後の接続を番人が切ってしまう。
    // その状態は upgrade が失敗する経路からは観測できないので、ここで集合そのものを見る。
    expect([...WS_PATHS].sort()).toEqual(['/ws', '/ws/pty']);
  });

  const upgrade = (url: string | undefined): boolean => {
    const server = new EventEmitter();
    guardUpgrades(server as unknown as http.Server);
    let destroyed = false;
    server.emit('upgrade', { url }, { destroy: () => { destroyed = true; } });
    return destroyed;
  };

  it('握る経路への要求は切らない。クエリ文字列が付いていても経路で見る', () => {
    expect(upgrade('/ws')).toBe(false);
    expect(upgrade('/ws/pty?tab=t1')).toBe(false);
  });

  it('握らない経路への upgrade 要求は切る', () => {
    // upgrade を受けた時点でこの接続は HTTP 側の管理から外れるため、誰も引き取らないと相手が待ち続ける。
    expect(upgrade('/nope')).toBe(true);
    expect(upgrade('/ws/other')).toBe(true);
    expect(upgrade(undefined)).toBe(true);
  });
});
