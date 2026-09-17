import { describe, expect, it } from 'vitest';
import { splitFtsTokens, toFtsQuery } from './fts.ts';

describe('toFtsQuery', () => {
  it('トークンごとに二重引用符で包む', () => {
    expect(toFtsQuery('agent-hangar 動画チャンネル')).toBe('"agent-hangar" "動画チャンネル"');
  });
  it('二重引用符は二つ重ねて逃がす', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });
  it('3 文字未満のトークンは trigram で当たらないので落とす', () => {
    expect(toFtsQuery('ls docs/design.md')).toBe('"docs/design.md"');
  });
  it('残るトークンが無ければ null', () => {
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('  a  b ')).toBeNull();
  });
});

describe('splitFtsTokens', () => {
  it('3 文字以上を long、1 から 2 文字を short に分ける', () => {
    expect(splitFtsTokens('動画 channels ls')).toEqual({ long: ['channels'], short: ['動画', 'ls'] });
  });
  it('コードポイントで数えるので絵文字やサロゲートペアも 1 文字', () => {
    expect(splitFtsTokens('😀😀 😀😀😀')).toEqual({ long: ['😀😀😀'], short: ['😀😀'] });
  });
  it('空白だけなら両方とも空', () => {
    expect(splitFtsTokens('   ')).toEqual({ long: [], short: [] });
    expect(splitFtsTokens('')).toEqual({ long: [], short: [] });
  });
});
