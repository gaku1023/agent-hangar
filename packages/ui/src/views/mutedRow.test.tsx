import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { initialStore } from '../store/store.ts';
import { sessionDto } from '../test/sessionDto.ts';
import { presentSessionRow } from '../presenters/row.ts';

const NOW = new Date(2026, 10, 21, 9, 0).getTime();

describe('ミュートした会話の一覧の行（試作の L1）', () => {
  it('ミュートした会話の行だけが muted の語を持つ', () => {
    const quiet = sessionDto({ id: 'q', providerSessionId: 'uq', mutedAt: NOW });
    const loud = sessionDto({ id: 'l', providerSessionId: 'ul' });
    const store = { ...initialStore(), sessions: { q: quiet, l: loud } };
    expect(presentSessionRow(quiet, store, NOW).muted).toBe('ミュート中');
    expect(presentSessionRow(loud, store, NOW).muted).toBeUndefined();
  });
});

// 描画の確かめ（右端の印）は SessionRows の器ごと要るので、印の部品だけを見る。
import { MutedMark } from './SessionRows.tsx';
describe('MutedMark', () => {
  it('ベルの斜線を、読み上げの名前つきで出す', () => {
    const { container } = render(<MutedMark label="ミュート中" />);
    const el = container.querySelector('.row-muted')!;
    expect(el.getAttribute('title')).toBe('ミュート中');
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('ミュート中');
  });
});
