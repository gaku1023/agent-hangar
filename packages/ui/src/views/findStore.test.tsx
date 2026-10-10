import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFindStore, FindRoot, useFind } from './findStore.tsx';

afterEach(cleanup);

describe('本文の中の検索の状態（View の側で持つ）', () => {
  it('開くたびに欄へ戻る合図を進め、語を変えると数え直し、前へ次へで進め、閉じると消える', () => {
    const s = createFindStore();
    expect(s.get('s1')).toBeNull();
    s.open('s1');
    expect(s.get('s1')).toEqual({ query: '', caseSensitive: false, from: null, step: 0, n: 1 });
    s.query('s1', 'バリデーション', true, 12);
    s.step('s1', 1);
    s.step('s1', 1);
    expect(s.get('s1')).toEqual({ query: 'バリデーション', caseSensitive: true, from: 12, step: 2, n: 1 });
    s.query('s1', 'バリ', true, 12);
    expect(s.get('s1')?.step).toBe(0);
    // 開いたままもう一度 ⌘F を押すと、語は残したまま欄へ戻る。
    s.open('s1');
    expect(s.get('s1')).toMatchObject({ query: 'バリ', n: 2 });
    s.close('s1');
    expect(s.get('s1')).toBeNull();
    // 閉じているときの語と前へ次へは何もしない。
    s.step('s1', 1);
    s.query('s1', 'x', false, null);
    expect(s.get('s1')).toBeNull();
  });
  it('セッションごとに別々に持ち、変わったときだけ知らせる', () => {
    const s = createFindStore();
    const heard = vi.fn();
    const off = s.subscribe(heard);
    s.open('s1');
    s.query('s1', 'a', false, null);
    expect(s.get('s2')).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    // 閉じているものを閉じても、閉じているものを進めても知らせない。
    s.close('s2');
    s.step('s2', 1);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    s.close('s1');
    expect(heard).toHaveBeenCalledTimes(2);
  });
  it('FindRoot の下では、画面を外して戻しても状態が残る', () => {
    const s = createFindStore();
    function Probe(props: { id: string }) { const f = useFind(props.id); return <span>{f.state ? `${f.state.query}:${f.state.step}` : '閉'}</span>; }
    const r = render(<FindRoot store={s}><Probe id="s1" /></FindRoot>);
    expect(screen.getByText('閉')).toBeInTheDocument();
    act(() => { s.open('s1'); s.query('s1', '語', false, null); s.step('s1', 1); });
    expect(screen.getByText('語:1')).toBeInTheDocument();
    // 別のセッションの画面には出ない。
    r.rerender(<FindRoot store={s}><Probe id="s2" /></FindRoot>);
    expect(screen.getByText('閉')).toBeInTheDocument();
    r.rerender(<FindRoot store={s}><span>別の画面</span></FindRoot>);
    r.rerender(<FindRoot store={s}><Probe id="s1" /></FindRoot>);
    expect(screen.getByText('語:1')).toBeInTheDocument();
  });
  it('FindRoot が無ければ、その部品の中だけで持つ', () => {
    let api: ReturnType<typeof useFind> | null = null;
    function Probe() { api = useFind('s1'); return <span>{api.state ? `開:${api.state.n}` : '閉'}</span>; }
    render(<Probe />);
    act(() => api!.open());
    expect(screen.getByText('開:1')).toBeInTheDocument();
    act(() => api!.close());
    expect(screen.getByText('閉')).toBeInTheDocument();
  });
});
