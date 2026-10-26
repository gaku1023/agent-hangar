import { describe, expect, it } from 'vitest';
import { CODEX_ONE_TURN, fixtureBytes } from '../../../../test/codexFixtures.ts';
import { decompressZstd, ZstdTooLargeError } from './zstd.ts';

describe('decompressZstd', () => {
  it('zstd コマンドで圧縮した rollout が、元のバイト列に戻る', () => {
    const out = decompressZstd(fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    expect(out.equals(fixtureBytes(CODEX_ONE_TURN.file))).toBe(true);
  });

  it('壊れた入力は投げる', () => {
    const z = fixtureBytes(`${CODEX_ONE_TURN.file}.zst`);
    expect(() => decompressZstd(Buffer.from('not zstd at all'))).toThrow();
    expect(() => decompressZstd(z.subarray(0, Math.floor(z.length / 2)))).toThrow();
  });

  it('展開後が上限を超えるときは ZstdTooLargeError', () => {
    expect(() => decompressZstd(fixtureBytes(`${CODEX_ONE_TURN.file}.zst`), 100)).toThrow(ZstdTooLargeError);
  });
});
