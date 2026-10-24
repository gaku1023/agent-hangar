import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { UpdateNoteRow, UpdateSectionProps } from '../presenters/update.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { UpdateSection } from './UpdateSection.tsx';

const row = (version: string, open: boolean): UpdateNoteRow => ({ version, tag: null, before: null, points: [`${version} の要点`], count: '1 件', open, body: `- ${version} の本文。` });
const props = (notes: UpdateNoteRow[]): UpdateSectionProps => ({
  supported: true, unsupported: '', badge: null,
  version: { title: 'バージョン 1.4.2', sub: '', checkLabel: '更新を確認', checkDisabled: false },
  pending: null, notify: { on: true, info: '' }, tocState: '',
  notesTitle: 'リリースノート', beforeLabel: '更新の前に', notes,
});
const mount = (notes: UpdateNoteRow[]) => render(<LanguageRoot language="ja"><ActionRoot onAction={vi.fn()}><UpdateSection update={props(notes)} /></ActionRoot></LanguageRoot>);

describe('リリースノートの開き閉じの動き', () => {
  let restore: (() => void) | null = null;
  let animations: { el: Element; frames: Keyframe[]; resolve: () => void }[] = [];
  beforeEach(() => {
    restore = fakeMotionTokens(undefined, { everywhere: true });
    animations = [];
    (HTMLElement.prototype as unknown as { getAnimations: unknown }).getAnimations = () => [];
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
      let resolve!: () => void;
      const finished = new Promise<void>((r) => { resolve = r; });
      animations.push({ el: this, frames, resolve });
      return { finished, cancel: vi.fn() };
    };
  });
  afterEach(() => {
    restore?.(); restore = null;
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as unknown as { getAnimations?: unknown }).getAnimations;
  });

  it('はじめから開いている版は動かさず、押して開いた版は伸びて入る', () => {
    mount([row('1.4.2', true), row('1.4.1', false)]);
    expect(animations).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /1\.4\.1/ }));
    const body = screen.getByText('1.4.1 の要点').closest('.note-body');
    expect(animations.map((a) => a.el)).toContain(body);
  });

  it('閉じた版は畳み終えてから外れる', async () => {
    mount([row('1.4.2', true)]);
    fireEvent.click(screen.getByRole('button', { name: /1\.4\.2/ }));
    expect(screen.getByRole('button', { name: /1\.4\.2/ })).toHaveAttribute('aria-expanded', 'false');
    // 畳んでいる間は、中身を残す。
    const body = screen.getByText('1.4.2 の要点').closest('.note-body')!;
    const fold = animations.find((a) => a.el === body)!;
    expect(fold.frames.at(-1)).toMatchObject({ height: '0px' });
    await act(async () => { fold.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByText('1.4.2 の要点')).toBeNull();
  });

  it('「全文を読む」と「要点だけにする」では、本文の箱の高さを補間する', () => {
    // jsdom は高さを測らないので、中身の文字数を高さの代わりにする。
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.textContent?.length ?? 0; });
    try {
      mount([row('1.4.2', true)]);
      fireEvent.click(screen.getByRole('button', { name: '全文を読む' }));
      const body = screen.getByText('1.4.2 の本文。').closest('.note-body');
      expect(animations.find((a) => a.el === body)?.frames.map((f) => typeof f.height)).toEqual(['string', 'string']);
    } finally { h.mockRestore(); }
  });
});
