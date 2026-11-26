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
      // 段落ごとに頼む。
      expect(api.translate).toHaveBeenCalledTimes(40);
      expect(api.translate).toHaveBeenCalledWith(LONG.split('\n\n')[0]);
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

  describe('段落ずつ', () => {
    const P1 = 'I delayed the removal until the next sync, so the row no longer jumps.';
    const P2 = 'The test for the narrow sidebar now covers the case where the badge wraps.';
    const J1 = '削除を次の同期まで遅らせたので、行がジャンプしなくなりました。';
    const J2 = '狭い横の欄の試験で、札が折り返す場合も見るようにしました。';
    const LONG2 = `${P1}\n\n${P2}`;

    it('段落ごとに訳を頼み、届いた段落から訳文に置き換える。待つ印は届いていない段落にだけ残す', async () => {
      const waits = new Map<string, (v: string | null) => void>();
      const api = fakeApi({ translate: vi.fn((t: string) => new Promise<string | null>((r) => { waits.set(t, r); })) });
      const { container } = show(api, LONG2);
      // 下の段落から頼む（翻訳は後から頼んだものを先に訳すので、上の段落から届く）。
      expect(api.translate.mock.calls.map((c) => c[0])).toEqual([P2, P1]);
      waits.get(P1)!(J1);
      await waitFor(() => expect(container.textContent).toContain(J1));
      expect(container.textContent).toContain(P2);
      expect(container.querySelector('.msg-assistant')!.getAttribute('data-translating')).toBe('true');
      const blocks = [...container.querySelectorAll('.msg-block')];
      expect(blocks.map((b) => b.getAttribute('data-translating'))).toEqual([null, 'true']);
      // 訳文が 1 つでも届けば、原文に戻す切り替えを出す。
      expect(screen.getByRole('button', { name: '原文を表示' })).toBeTruthy();
      waits.get(P2)!(J2);
      await waitFor(() => expect(container.textContent).toContain(J2));
      expect(container.querySelector('[data-translating]')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '原文を表示' }));
      expect(container.textContent).toContain(P1);
      expect(container.textContent).toContain(P2);
    });

    it('覚えている段落は待たずに訳文で出し、残りの段落だけを頼む', async () => {
      const api = fakeApi({ cached: (t) => (t === P1 ? J1 : null), translate: vi.fn(async () => J2) });
      const { container } = show(api, LONG2);
      expect(container.textContent).toContain(J1);
      expect(api.translate.mock.calls.map((c) => c[0])).toEqual([P2]);
      await waitFor(() => expect(container.textContent).toContain(J2));
    });
  });
});
