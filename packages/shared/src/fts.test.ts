import { describe, expect, it } from 'vitest';
import { toFtsQuery } from './fts.ts';

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
