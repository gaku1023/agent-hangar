import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { toolItem } from '../test/items.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { Transcript } from './Transcript.tsx';

afterEach(cleanup);

const bash = (seq: number, description: string, isError = false) => toolItem(seq, 'Bash', { command: `grep -rn x${seq} src`, description }, { text: isError ? 'boom' : 'ok', isError }, { when: `10:0${seq}` });
const items: TranscriptItem[] = [
  { kind: 'user', seq: 0, text: 'バーの色は？', when: '10:00' },
  bash(1, '一覧を出す'), bash(2, '型を調べる'), bash(3, '描画を読む'),
  { kind: 'assistant', seq: 4, text: '分かりました', when: '10:05' },
  bash(5, '色を探す'),
];

function draw(list: TranscriptItem[] = items, language: 'ja' | 'en' = 'ja') {
  const onAction = vi.fn();
  const r = render(<LanguageRoot language={language}><ActionRoot onAction={onAction}><Transcript sessionId="s1" items={list} hasMore={false} loading={false} follow={false} live={false} remaining={0} groupTools /></ActionRoot></LanguageRoot>);
  const group = (seq: number) => r.container.querySelector(`.tr-row[data-seq="${seq}"] .tool-group`) as HTMLElement;
  return { ...r, onAction, group };
}

describe('続けて呼んだツールのまとめ（T1）', () => {
  it('続けて並ぶ呼び出しを 1 行に畳み、札、最後の説明、時刻を並べる。中身はまだ描かない', () => {
    const t = draw();
    expect(t.container.querySelectorAll('.tr-row')).toHaveLength(4);
    const g = t.group(1);
    const row = within(g).getByRole('button', { expanded: false });
    expect(row.querySelector('.tg-badge')?.textContent).toBe('Bash ×3');
    expect(row.querySelector('.tg-desc')?.textContent).toBe('描画を読む');
    expect(row.querySelector('.tg-when')?.textContent).toBe('10:03');
    expect(g.querySelector('.tool')).toBeNull();
  });
  it('押すと、左の線の付いた一覧に呼び出しを 1 行ずつ開き、各行は押すと入出力が開く', () => {
    const t = draw();
    const g = t.group(1);
    fireEvent.click(within(g).getByRole('button', { expanded: false }));
    const list = g.querySelector('.tg-list')!;
    const lines = list.querySelectorAll('.tool.tool-compact');
    expect(lines).toHaveLength(3);
    expect(lines[0]!.querySelector('.tool-sum')?.textContent).toContain('grep -rn x1 src');
    expect(list.querySelector('.bash')).toBeNull();
    fireEvent.click(lines[1]!.querySelector('.trow')!);
    expect(lines[1]!.querySelector('.bash .cmd')?.textContent).toContain('grep -rn x2 src');
    // もう一度押すと畳む。
    fireEvent.click(within(g).getByRole('button', { name: /Bash ×3/ }));
    expect(g.querySelector('.tg-list')).toBeNull();
  });
  it('1 回だけの呼び出しも同じ 1 行の形で、×1 は出さない。押すとすぐ中身まで開く', () => {
    const t = draw();
    const g = t.group(5);
    const row = within(g).getByRole('button', { expanded: false });
    expect(row.querySelector('.tg-badge')?.textContent).toBe('Bash');
    expect(row.querySelector('.tg-desc')?.textContent).toBe('色を探す');
    fireEvent.click(row);
    expect(g.querySelector('.tg-list .bash .cmd')?.textContent).toContain('grep -rn x5 src');
  });
  it('失敗した呼び出しがあれば、まとめの行にも印と数を出す', () => {
    const t = draw([bash(1, 'a'), bash(2, 'b', true)]);
    const g = t.group(1);
    expect(g).toHaveAttribute('data-failed', 'true');
    expect(g.querySelector('.tg-failed')?.textContent).toBe('失敗 1');
    expect(draw([bash(1, 'a')]).group(1)).not.toHaveAttribute('data-failed');
  });
  it('種類が混ざれば「ツール ×N」', () => {
    const t = draw([bash(1, 'a'), toolItem(2, 'Read', { file_path: '/w/app/src/a.ts' }, null)]);
    expect(t.group(1).querySelector('.tg-badge')?.textContent).toBe('ツール ×2');
    expect(t.group(1).querySelector('.tg-desc')?.textContent).toBe('src/a.ts');
  });
  it('サブエージェントを起こした呼び出しは 1 つで置き、畳んだままでも「見る」を押せる', () => {
    const agent = toolItem(2, 'Agent', { description: '調べる' }, null, { subagent: { agentId: 'abc', label: 'x' } });
    const t = draw([bash(1, 'a'), agent, bash(3, 'b')]);
    expect(t.container.querySelectorAll('.tr-row')).toHaveLength(3);
    fireEvent.click(screen.getByText('サブエージェント abc を表示'));
    expect(t.onAction).toHaveBeenCalledWith({ type: 'transcript.selectAgent', sessionId: 's1', agentId: 'abc' });
    // 開いても、ボタンは 1 つだけ。
    fireEvent.click(within(t.group(2)).getByRole('button', { name: /Agent/ }));
    expect(screen.getAllByText('サブエージェント abc を表示')).toHaveLength(1);
  });
  it('まとめないとき（詳細表示）は、今までどおり 1 行ずつのツールの行にする', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Transcript sessionId="s1" items={items} hasMore={false} loading={false} follow={false} live={false} remaining={0} /></ActionRoot>);
    expect(container.querySelector('.tool-group')).toBeNull();
    expect(container.querySelectorAll('.tool')).toHaveLength(4);
  });
  it('英語の札と失敗の語', () => {
    const t = draw([bash(1, 'a', true), toolItem(2, 'Read', { file_path: '/w/app/src/a.ts' }, null)], 'en');
    expect(t.group(1).querySelector('.tg-badge')?.textContent).toBe('Tools ×2');
    expect(t.group(1).querySelector('.tg-failed')?.textContent).toBe('1 failed');
  });
});
