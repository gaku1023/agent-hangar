import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderItem } from './Transcript.tsx';
import { TranslateContext, type TranslateApi } from './translateMsg.tsx';
import { OpenContext } from './transcriptOpen.tsx';

const EN = 'I delayed the removal until the next sync, so the row no longer jumps.';
const JA = '削除を次の同期まで遅らせたので、行がジャンプしなくなりました。';

afterEach(cleanup);

function fakeApi(over: Partial<TranslateApi> = {}): TranslateApi & { translate: ReturnType<typeof vi.fn> } {
  return { cached: () => null, translate: vi.fn(async () => JA), ...over } as TranslateApi & { translate: ReturnType<typeof vi.fn> };
}

const show = (api: TranslateApi | null, text = EN, kind: 'assistant' | 'thinking' = 'assistant') =>
  render(<TranslateContext.Provider value={api}>{renderItem('s1', { kind, seq: 1, text, when: '10:00' })}</TranslateContext.Provider>);

describe('TranslatableMsg', () => {
  it('翻訳が配られていなければ（設定が切）原文のまま出し、切り替えも出さない', () => {
    const { container } = show(null);
    expect(container.textContent).toContain(EN);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('英語の返答は、待つ間は印を付けて原文を出し、届いたら訳文に置き換える', async () => {
    const api = fakeApi();
    const { container } = show(api);
    const msg = container.querySelector('.msg-assistant')!;
    expect(msg.getAttribute('data-translating')).toBe('true');
    expect(container.textContent).toContain(EN);
    await waitFor(() => expect(container.textContent).toContain(JA));
    expect(msg.getAttribute('data-translating')).toBeNull();
    expect(api.translate).toHaveBeenCalledWith(EN);
  });

  it('切り替えで原文に戻し、もう一度押すと訳文に戻す', async () => {
    const { container } = show(fakeApi());
    await waitFor(() => expect(container.textContent).toContain(JA));
    const btn = screen.getByRole('button', { name: '原文を表示' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(container.textContent).toContain(EN);
    fireEvent.click(screen.getByRole('button', { name: '訳文を表示' }));
    expect(container.textContent).toContain(JA);
  });

  it('短い思考は自動では訳さず、訳すアイコンを押すと訳す', async () => {
    const api = fakeApi();
    const { container } = show(api, EN, 'thinking');
    expect(api.translate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-translating]')).toBeNull();
    const btn = screen.getByRole('button', { name: '訳文を表示' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    await waitFor(() => expect(container.textContent).toContain(JA));
    expect(api.translate).toHaveBeenCalledWith(EN);
    expect(screen.getByRole('button', { name: '原文を表示' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('覚えている訳がある思考は、押さずに訳文で出す', () => {
    const { container } = show(fakeApi({ cached: () => JA }), EN, 'thinking');
    expect(container.textContent).toContain(JA);
  });

  describe('長い思考（畳まれる）', () => {
    const LONG = Array.from({ length: 40 }, (_, i) => `Line ${i}: I delayed the removal until the next sync, so the row no longer jumps.`).join('\n\n');
    const withOpens = (api: TranslateApi, open: boolean) => {
      const opens = { get: (_s: number, part: string) => (part === 'msg' ? open : undefined), set: vi.fn(), revealed: () => false };
      return render(<OpenContext.Provider value={opens}><TranslateContext.Provider value={api}>{renderItem('s1', { kind: 'thinking', seq: 1, text: LONG, when: '10:00' })}</TranslateContext.Provider></OpenContext.Provider>);
    };

    it('畳んでいる間は訳さず、訳すアイコンも出さない', () => {
      const api = fakeApi();
      const { container } = withOpens(api, false);
      expect(api.translate).not.toHaveBeenCalled();
      expect(container.querySelector('.msg-translate')).toBeNull();
    });

    it('すべて表示で開いたら訳しに行く', async () => {
      const api = fakeApi();
      const { container } = withOpens(api, true);
      await waitFor(() => expect(container.textContent).toContain(JA));
      expect(api.translate).toHaveBeenCalledWith(LONG);
    });
  });

  it('返答は今までどおり、見えたら自動で訳す', async () => {
    const api = fakeApi();
    show(api, EN, 'assistant');
    await waitFor(() => expect(api.translate).toHaveBeenCalledWith(EN));
  });

  it('検索や会話を開いたときの跳び先（revealed）でも、原文に戻さず訳文を見せる', async () => {
    const opens = { get: () => undefined, set: vi.fn(), revealed: () => true };
    const { container } = render(<OpenContext.Provider value={opens}><TranslateContext.Provider value={fakeApi()}>{renderItem('s1', { kind: 'assistant', seq: 1, text: EN, when: '10:00' })}</TranslateContext.Provider></OpenContext.Provider>);
    await waitFor(() => expect(container.textContent).toContain(JA));
  });

  it('日本語の返答は訳さない', () => {
    const api = fakeApi();
    const { container } = show(api, JA);
    expect(api.translate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-translating]')).toBeNull();
  });

  it('覚えている訳があれば、待たずに訳文で出す', () => {
    const api = fakeApi({ cached: () => JA });
    const { container } = show(api);
    expect(container.textContent).toContain(JA);
    expect(api.translate).not.toHaveBeenCalled();
  });

  it('訳せなければ（plamo-translate が無い）原文のまま出し、待つ印も外す', async () => {
    const { container } = show(fakeApi({ translate: vi.fn(async () => null) }));
    await waitFor(() => expect(container.querySelector('[data-translating]')).toBeNull());
    expect(container.textContent).toContain(EN);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
