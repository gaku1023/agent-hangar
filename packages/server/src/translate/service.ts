import { isEnglishText, type TranslateResultDto } from '@agent-hangar/shared';
import { PlamoUnavailableError } from './plamo.ts';

/** 訳を覚えておく件数。会話をいくつか行き来しても訳し直さずに済む程度にする。hangar を起こし直すと忘れる。 */
export const CACHE_MAX = 500;

export type Translator = { available(): boolean; translate(text: string): Promise<string> };

/**
 * 画面から頼まれた英語の文を訳す。設定が切なら off、plamo-translate が無ければ unavailable を返す。
 * 訳はメモリに覚え（古いものから捨てる）、同じ文を同時に頼まれたら 1 回だけ訳す。
 */
export class TranslateService {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<TranslateResultDto>>();

  constructor(private readonly translator: Translator, private readonly enabled: () => boolean, private readonly max = CACHE_MAX) {}

  translate(text: string): Promise<TranslateResultDto> {
    if (!this.enabled()) return Promise.resolve({ status: 'off' });
    const hit = this.cache.get(text);
    if (hit !== undefined) {
      // 使ったものを新しい側へ寄せる。
      this.cache.delete(text);
      this.cache.set(text, hit);
      return Promise.resolve({ status: 'ok', text: hit });
    }
    // 英語でない文（日本語の返答、短すぎる文、長すぎる文）は訳さない。画面も同じ判定で頼まないが、念のためサーバでも見る。
    if (!isEnglishText(text)) return Promise.resolve({ status: 'ok', text });
    if (!this.translator.available()) return Promise.resolve({ status: 'unavailable' });
    const running = this.inflight.get(text);
    if (running) return running;
    const job = this.translator.translate(text).then(
      (out): TranslateResultDto => {
        this.remember(text, out);
        return { status: 'ok', text: out };
      },
      (e: unknown): TranslateResultDto => (e instanceof PlamoUnavailableError ? { status: 'unavailable' } : { status: 'error', message: e instanceof Error ? e.message : String(e) }),
    ).finally(() => { this.inflight.delete(text); });
    this.inflight.set(text, job);
    return job;
  }

  private remember(text: string, out: string): void {
    this.cache.set(text, out);
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
