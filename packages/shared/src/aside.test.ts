import { describe, expect, it } from 'vitest';
import { asideHead, asideMark, asideOf } from './aside.ts';

describe('裏だけ動いている（aside）', () => {
  it('作業中で裏の印があるときだけ裏だけと読む', () => {
    const a = { shell: true, agents: 0 };
    expect(asideOf('busy', a)).toEqual(a);
    expect(asideOf('busy', null)).toBeNull();
    expect(asideOf('busy', undefined)).toBeNull();
    // 入力待ちと休みは本体の状態のほうが強い。古い印が残っていても裏だけとは読まない。
    expect(asideOf('waiting', a)).toBeNull();
    expect(asideOf('idle', a)).toBeNull();
    expect(asideOf(null, a)).toBeNull();
  });
  it('サイドバーの短い語は、サブエージェントの本数が分かればそれを添える', () => {
    expect(asideMark({ shell: true, agents: 0 })).toBe('裏');
    expect(asideMark({ shell: false, agents: 2 })).toBe('裏 2');
  });
  it('灯の見出しは、サブエージェントなら本数、シェルだけならシェルと言う', () => {
    expect(asideHead({ shell: true, agents: 0 })).toBe('裏でシェルが動いている');
    expect(asideHead({ shell: false, agents: 1 })).toBe('裏で 1 本動いている');
    expect(asideHead({ shell: true, agents: 2 })).toBe('裏で 2 本動いている');
    // 裏の担当が数えられないとき（workflow など）。
    expect(asideHead({ shell: false, agents: 0 })).toBe('裏で作業が動いている');
  });
});
