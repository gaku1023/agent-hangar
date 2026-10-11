import { describe, expect, it } from 'vitest';
import { ja } from './ja.ts';

/**
 * 日本語の文で、名前を入れる場所（{name}、{names}、{mux}、それとパスの入る {label}）の後ろに助詞が直接続かないようにする。
 * 名前は英字のこと（tmux、claude、~/.claude、利用者が付けたアカウントの名前）があり、詰めると「tmuxは準備完了」のように読みにくい。
 * 辞書のほかの文（「{name} を削除」「{name} に切り替えますか？」）と同じく、名前と助詞の間に空白を置く。
 */
const NAMED = /\{(name|names|mux|label)\}(は|が|を|に|で|と|の|も|へ|から|まで|より)/;

/**
 * 決めて外すもの。
 * ToDo の {name} は「本文（2 件目）」の形で、閉じ括弧で終わるので詰める。
 * 部品の {label} は辞書の日本語の見出し（「プロジェクト」など）だけが入るので詰める。
 */
const EXEMPT = new Set([
  'projectScreen.todo.delete',
  'projectScreen.todo.confirm',
  'projectScreen.todo.reject',
  'pager.nav.label',
  'primitives.listbox.search',
  'primitives.stepper.decrease',
  'primitives.stepper.increase',
]);

describe('日本語の文の名前と助詞の間', () => {
  it('名前を入れる場所の後ろに、助詞を詰めて続けない', () => {
    const bad = Object.entries(ja as Record<string, string>)
      .filter(([k, v]) => !EXEMPT.has(k) && NAMED.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(bad).toEqual([]);
  });
  it('外したものは、まだ辞書にある', () => {
    for (const k of EXEMPT) expect(ja as Record<string, string>, k).toHaveProperty(k);
  });
});
