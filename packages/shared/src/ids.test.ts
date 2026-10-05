import { describe, expect, it } from 'vitest';
import { newId, runTmuxId, shortId } from './ids.ts';

describe('newId', () => {
  it('UUID v7 の形をしている', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('連続して作ると辞書順が時刻順になる', () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });
});

describe('shortId', () => {
  it('ハイフンを除いた先頭 8 文字を返す', () => {
    expect(shortId('01926b3c-9d2e-7abc-8def-0123456789ab')).toBe('01926b3c');
  });
});

describe('runTmuxId', () => {
  it('時刻の先頭 8 桁に、乱数の末尾 8 桁を足す', () => {
    expect(runTmuxId('01926b3c-9d2e-7abc-8def-0123456789ab')).toBe('01926b3c456789ab');
  });
  it('同じ約 65 秒の窓で作った id でも重ならない', () => {
    // uuidv7 の先頭 8 桁はミリ秒の時刻の上位 32 ビットで、約 65.5 秒のあいだ変わらない。
    const ids = Array.from({ length: 200 }, () => newId());
    expect(new Set(ids.map(shortId)).size).toBeLessThan(ids.length);
    expect(new Set(ids.map(runTmuxId)).size).toBe(ids.length);
  });
  it('tmux の名前の型（16 進だけ）に収まる', () => {
    expect(runTmuxId(newId())).toMatch(/^[0-9a-f]{16}$/);
  });
});
