import { describe, expect, it } from 'vitest';
import { renderInjection } from './injection.ts';

describe('renderInjection', () => {
  it('テンプレートの各要素を埋める', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', memo: 'メモ本文', todos: ['a', 'b'] });
    expect(t).toContain('あなたは agent-hangar から起動されたセッションです。');
    expect(t).toContain('プロジェクト：alpha（/w/alpha）');
    expect(t).toContain('プロジェクトのメモの要約：メモ本文');
    expect(t).toContain('未完の TODO：\n- a\n- b');
    expect(t).toContain('search_sessions と get_transcript');
    expect(t).toContain('set_session_summary');
  });
  it('メモは 500 字、TODO は 10 件に切り、無ければ（なし）', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(600), todos: Array.from({ length: 12 }, (_, i) => `t${i}`) });
    expect(t).toContain('あ'.repeat(500) + '\n');
    expect(t).not.toContain('あ'.repeat(501));
    expect(t).toContain('- t9\n');
    expect(t).not.toContain('- t10');
    const e = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: [] });
    expect(e).toContain('プロジェクトのメモの要約：（なし）');
    expect(e).toContain('未完の TODO：（なし）');
  });
  it('メモはちょうど 500 字なら切らず、501 字なら最後の 1 字だけを落とす', () => {
    // 境界を直接踏む。末尾に目印を置くと、1 字ずれても見分けられる。
    const at500 = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(499) + '印', todos: [] });
    expect(at500).toContain('プロジェクトのメモの要約：' + 'あ'.repeat(499) + '印\n');
    const at501 = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(500) + '印', todos: [] });
    expect(at501).toContain('プロジェクトのメモの要約：' + 'あ'.repeat(500) + '\n');
    expect(at501).not.toContain('印');
  });
  it('TODO はちょうど 10 件なら全部、11 件なら 11 件目だけを落とす', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
    const at10 = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: items(10) });
    expect(at10).toContain('未完の TODO：\n' + items(10).map((t) => `- ${t}`).join('\n') + '\n');
    const at11 = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: items(11) });
    expect(at11).toContain('- t10\n');
    expect(at11).not.toContain('- t11');
  });
});
