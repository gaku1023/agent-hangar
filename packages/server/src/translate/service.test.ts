import { describe, expect, it, vi } from 'vitest';
import { PlamoUnavailableError } from './plamo.ts';
import { TranslateService, type Translator } from './service.ts';

const EN = 'I delayed the removal until the next sync, so the row no longer jumps.';
const EN2 = 'The second English sentence that is long enough to be translated here.';
const EN3 = 'The third English sentence that is long enough to be translated as well.';

function fake(over: Partial<Translator> = {}): Translator & { translate: ReturnType<typeof vi.fn> } {
  return { available: () => true, translate: vi.fn(async (t: string) => `訳:${t}`), ...over } as Translator & { translate: ReturnType<typeof vi.fn> };
}

describe('TranslateService', () => {
  it('設定が切なら off を返し、訳さない', async () => {
    const tr = fake();
    await expect(new TranslateService(tr, () => false).translate(EN)).resolves.toEqual({ status: 'off' });
    expect(tr.translate).not.toHaveBeenCalled();
  });

  it('英語を訳し、2 回目は覚えた訳を返す', async () => {
    const tr = fake();
    const s = new TranslateService(tr, () => true);
    await expect(s.translate(EN)).resolves.toEqual({ status: 'ok', text: `訳:${EN}` });
    await expect(s.translate(EN)).resolves.toEqual({ status: 'ok', text: `訳:${EN}` });
    expect(tr.translate).toHaveBeenCalledTimes(1);
  });

  it('同じ文を同時に頼まれたら 1 回だけ訳す', async () => {
    const tr = fake();
    const s = new TranslateService(tr, () => true);
    await Promise.all([s.translate(EN), s.translate(EN)]);
    expect(tr.translate).toHaveBeenCalledTimes(1);
  });

  it('英語でない文はそのまま返す', async () => {
    const tr = fake();
    await expect(new TranslateService(tr, () => true).translate('テストは全部通りました。')).resolves.toEqual({ status: 'ok', text: 'テストは全部通りました。' });
    expect(tr.translate).not.toHaveBeenCalled();
  });

  it('plamo-translate が無ければ unavailable、ほかの失敗は error', async () => {
    await expect(new TranslateService(fake({ available: () => false }), () => true).translate(EN)).resolves.toEqual({ status: 'unavailable' });
    await expect(new TranslateService(fake({ translate: vi.fn(async () => { throw new PlamoUnavailableError(); }) }), () => true).translate(EN)).resolves.toEqual({ status: 'unavailable' });
    await expect(new TranslateService(fake({ translate: vi.fn(async () => { throw new Error('boom'); }) }), () => true).translate(EN)).resolves.toEqual({ status: 'error', message: 'boom' });
  });

  it('覚える件数を超えたら、いちばん長く使っていないものから捨てる', async () => {
    const tr = fake();
    const s = new TranslateService(tr, () => true, 2);
    await s.translate(EN);
    await s.translate(EN2);
    await s.translate(EN); // EN を新しい側へ
    await s.translate(EN3); // EN2 が捨てられる
    tr.translate.mockClear();
    await s.translate(EN);
    expect(tr.translate).not.toHaveBeenCalled();
    await s.translate(EN2);
    expect(tr.translate).toHaveBeenCalledTimes(1);
  });
});
