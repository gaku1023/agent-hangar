import { translator } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { asideHead, asideOf } from './aside.ts';

const ja = translator('ja');
const en = translator('en');

describe('裏だけ動いている（aside）', () => {
  it('作業中で裏の印があるときだけ裏だけと読む', () => {
    const a = { shell: true, agents: 0 };
    expect(asideOf('busy', a)).toEqual(a);
    expect(asideOf('busy', null)).toBeNull();
    // 入力待ちと休みは本体の状態のほうが強い。古い印が残っていても裏だけとは読まない。
    expect(asideOf('waiting', a)).toBeNull();
    expect(asideOf('idle', a)).toBeNull();
    expect(asideOf(null, a)).toBeNull();
  });
  it('灯の見出しは、サブエージェントなら本数、シェルだけならシェルと言う', () => {
    expect(asideHead(ja, { shell: true, agents: 0 })).toBe('バックグラウンドでシェル');
    expect(asideHead(ja, { shell: false, agents: 1 })).toBe('バックグラウンドで 1 本');
    expect(asideHead(ja, { shell: true, agents: 2 })).toBe('バックグラウンドで 2 本');
    // 裏の担当が数えられないとき（workflow など）。
    expect(asideHead(ja, { shell: false, agents: 0 })).toBe('バックグラウンドで作業中');
  });
  it('英語でも言える。サブエージェントは 1 本なら単数', () => {
    expect(asideHead(en, { shell: false, agents: 1 })).toBe('1 subagent in background');
    expect(asideHead(en, { shell: false, agents: 2 })).toBe('2 subagents in background');
    expect(asideHead(en, { shell: true, agents: 0 })).toBe('Shell in the background');
  });
});
