import { describe, expect, it } from 'vitest';
import { asideHead, asideOf } from './aside.ts';

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
  it('灯の見出しは、サブエージェントなら本数、シェルだけならシェルと言う', () => {
    expect(asideHead({ shell: true, agents: 0 })).toBe('バックグラウンドでシェル');
    expect(asideHead({ shell: false, agents: 1 })).toBe('バックグラウンドで 1 本');
    expect(asideHead({ shell: true, agents: 2 })).toBe('バックグラウンドで 2 本');
    // 裏の担当が数えられないとき（workflow など）。
    expect(asideHead({ shell: false, agents: 0 })).toBe('バックグラウンドで作業中');
  });
});
